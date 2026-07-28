var { McpServer } = require('@modelcontextprotocol/sdk/server/mcp.js');
var { StreamableHTTPServerTransport } = require('@modelcontextprotocol/sdk/server/streamableHttp.js');
var express = require('jsharmony/lib/express');
var https = require('https');
var http = require('http');
var fs = require('fs');
var crypto = require('crypto');
var _ = require('lodash');
var { z } = require('zod');

function jsHarmonyCMSMCPServer(cms){
  this.cms = cms;
  this.jsh = cms.jsh;
  this.transports = {};
}


jsHarmonyCMSMCPServer.prototype.Run = function(run_cb){

  if(!run_cb) run_cb = function(){};

  var _this = this;
  var jsh = _this.jsh;
  var transports = _this.transports;
  var app = express();

  app.post('/mcp', async function(req, res){
    try {
      var sessionId = req.headers['mcp-session-id'];
      jsh.Log.info('Incoming MCP request. Session: ' + (sessionId || 'new'));
  
      var session = sessionId ? transports[sessionId] : null;

      if(session){
        await session.transport.handleRequest(req, res);
        return;
      }
  
      var transport = new StreamableHTTPServerTransport({
        sessionIdGenerator: function(){
          return crypto.randomUUID();
        }
      });
  
      var mcpServer = new McpServer({
        name:'jsHarmony MCP Server',
        version:'1.0.0'
      });

      var mcpContext = {
        user: req.user,
        site: req.site,
        jsh,
        funcs: _this.cms.funcs,
      };
  
      // Tools
      attachTools(mcpServer, mcpContext)
  
      await mcpServer.connect(transport);
  
      transport.onclose = function(){
        jsh.Log.info('MCP session closed: ' + transport.sessionId);
        delete transports[transport.sessionId];
      };
  
      await transport.handleRequest(req, res);
  
      if(transport.sessionId){
        transports[transport.sessionId] = {
          server:mcpServer,
          transport:transport
        };
  
        jsh.Log.info('Saved MCP session: ' + transport.sessionId);
      }
    }
    catch(err){
      jsh.Log.error('MCP Error: ' + err.toString());
  
      if(!res.headersSent){
        res.status(500).json({ error:err.toString() });
      }
    }
  });

  var isHTTPS = !!jsh.Config.server.https_key;
  var server = null;

  if(isHTTPS){

    var https_options = {
      key: fs.readFileSync(jsh.Config.server.https_key),
      cert: fs.readFileSync(jsh.Config.server.https_cert)
    };

    if(jsh.Config.server.https_ca){
      https_options.ca = fs.readFileSync(jsh.Config.server.https_ca);
    }

    server = https.createServer(
      https_options,
      app
    );
  }
  else {
    server = http.createServer(app);
  }

  server.listen(_this.cms.Config.mcp.serverPort, function(){
    jsh.Log.info('MCP Server listening on port ' + _this.cms.Config.mcp.serverPort);
    return run_cb();
  });
};

async function attachTools(mcpServer, context) {  
  mcpServer.registerTool(
    'listTemplates',
    {
      description:'Retrieve a list of available templates.'
    },
    async function(){
      var sql = 'select 1 code_val, "site_id" code_txt;'; // xxxx hs fix site id

      var templates = await new Promise(function(resolve,reject){
        context.jsh.AppSrv.ExecRow('system', sql, [], {}, function(err,rslt){
          if(err) return reject(err);
          if (!rslt || !rslt.length || !rslt[0]) return reject(new Error('An unexpected error has occurred'));
          var fake_rslt = [ // xxxx hs fix site id
            { code_val: '', code_txt: 'Please Select...' },
            { code_val: 1, code_txt: 'site_id' }
          ];
          context.funcs.getCurrentPageTemplatesLOV('system', fake_rslt, {}, function(err, pageTemplates) {
            if (err) {
              reject(err);
            } else {
              resolve(_.map(pageTemplates, function(template) { return { id: template.code_val, name: template.code_txt }; }));
            }
          });
        }, undefined, context.jsh.getDB('default'));
      });

      if(!templates){
        throw new Error('An error occurred while retrieving the templates.');
      }

      return {
        content:[{
          type:'text',
          text: 'Retrieved ' + templates.length + ' templates.'
        }],
        structuredContent: {
          'templates': templates
        }
      };
    }
  );

  mcpServer.registerTool(
    'getTemplate',
    {
      description:'Get a specified page template.',
      inputSchema: {
        template_id: z.string().describe('Template ID to retrieve')
      }
    },
    async function({ template_id }){
      var sql = 'select 1;'; // xxxx hs fix site id

      var template = await new Promise(function(resolve,reject){
        context.jsh.AppSrv.ExecScalar('system', sql, [], {}, function(err,rslt){
          if(err) return reject(err);
          if (!rslt || !rslt.length) return reject(new Error('An unexpected error has occurred'));
          context.funcs.getPageTemplate('system', rslt, template_id, {}, function(err, pageTemplate) {
            if (err) {
              reject(err);
            } else {
              resolve(pageTemplate);
            }
          });
        }, undefined, context.jsh.getDB('default'));
      });

      if(!template){
        throw new Error('Template not found.');
      }
  
      return {
        content:[{
          type:'text',
          text: 'Retrieved template: ' + template.title
        }],
        // xxxx hs maybe only return id, name, path, fields
        // xxxx hs mabye don't return content
        // xxxx hs mabye change title to name for Claude
        structuredContent:{
          id: template_id,
          title: template.title,
          location: template.location,
          path: template.path,
          fields: template.properties.fields,
          contentElements: template.content_elements,
          content: template.content,
        }
      };
    }
  );


  mcpServer.registerTool(
    'listBranches',
    {
      description:'Retrieve the list of active branches.',
    },
    async function(){
      var sql = "select branch_id id , branch_name name, branch_type type from cms.branch where branch_sts = 'ACTIVE';";

      var branches = await new Promise(function(resolve,reject){
        context.jsh.AppSrv.ExecRecordset('system', sql, [], {}, function(err,rslt){
          if(err) return reject(err);
          if (!rslt || !rslt.length || !rslt[0]) return reject(new Error('An unexpected error has occurred'));
          resolve(rslt[0]);
        }, undefined, context.jsh.getDB('default'));
      });

      if(!branches){
        throw new Error('An error occurred while retrieving the branches.');
      }

      return {
        content:[{
          type:'text',
          text: 'Retrieved ' + branches.length + ' branches.'
        }],
        structuredContent:{
          'branches': branches,
        }
      };
    }
  );

  mcpServer.registerTool(
    'listPages',
    {
      description:'Retrieve the list of existing pages.',
      inputSchema: {
        branch_id: z.number().describe('Template ID to retrieve')
      }
    },
    async function({ branch_id }){
      var sql = [
        'select page.page_id, page.page_key, page_title, page_path, page_folder, page_template_id, page_seo_title, page_seo_canonical_url, page_seo_metadesc, page_seo_keywords',
        'from cms.page',
        '  inner join cms.branch_page on branch_page.page_id=page.page_id',
        'where branch_page.branch_id = @branch_id;'
      ];
    
      var pages = await new Promise(function(resolve,reject){
        context.jsh.AppSrv.ExecRecordset('system', sql, [context.jsh.AppSrv.DB.types.BigInt], { branch_id: branch_id }, function(err,rslt){
          if(err) return reject(err);
          if (!rslt || !rslt.length || !rslt[0]) return reject(new Error('An unexpected error has occurred'));
          resolve(rslt[0]);
        }, undefined, context.jsh.getDB('default'));
      });

      if(!pages){
        throw new Error('An error occurred while retrieving the pages.');
      }

      return {
        content:[{
          type:'text',
          text: 'Retrieved ' + pages.length + ' pages.'
        }],
        structuredContent:{
          'pages': pages,
        }
      };
    }
  );
}


module.exports = exports = jsHarmonyCMSMCPServer;