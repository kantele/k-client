var Page = require('./Page');
var util = require('k-model/lib/util');
var contexts = require('k-templates').contexts;
var useragent = require('useragent');

Page.prototype.render = function(status, ns) {
  if (typeof status !== 'number') {
    ns = status;
    status = null;
  }
  this.app.emit('render', this);

  if (status) this.res.statusCode = status;
  // Prevent the browser from storing the HTML response in its back cache, since
  // that will cause it to render with the data from the initial load first
  this.res.setHeader('Cache-Control', 'no-store');
  // Set HTML utf-8 content type unless already set
  if (!this.res.getHeader('Content-Type')) {
    this.res.setHeader('Content-Type', 'text/html; charset=utf-8');
  }

  this._setRenderParams(ns);
  var pageHtml = this.get('Page', ns);
  this.res.write(pageHtml);
  this.res.write(
    '<script async src="' + this.app.scriptUrl + '"></script>' +
    '<script type="application/json">'
  );
  var tailHtml = this.get('Tail', ns);

  this.model.destroy('$components');

  var page = this;
  this.model.bundle(function(err, bundle) {
    if (page.model.hasErrored) return;
    if (err) return page.emit('error', err);
    var json = stringifyBundle(bundle);
    page.res.write(json);
    page.res.end('</script>' + tailHtml);
    page.app.emit('routeDone', page, 'render');
  });
};

Page.prototype.renderStatic = function(status, ns) {
  if (typeof status !== 'number') {
    ns = status;
    status = null;
  }
  this.app.emit('renderStatic', this);

  if (status) this.res.statusCode = status;
  this.params = pageParams(this.req);
  this._setRenderParams(ns);
  var pageHtml = this.get('Page', ns);
  var tailHtml = this.get('Tail', ns);
  this.res.send(pageHtml + tailHtml);
  this.app.emit('routeDone', this, 'renderStatic');
};

Page.prototype.shouldWeSendBundle = function() {
    if (this.req && this.req.headers) {
      var agent = useragent.parse(this.req.headers['user-agent']);

      if (agent) {
        if ((agent.family === 'IE Mobile' && agent.major === '9') || (agent.family === 'IE' && parseInt(agent.major, 10) < 11 )) {
          return false;
        }
      }
    }

    return true;
};

// Don't register any listeners on the server
Page.prototype._addListeners = function() {};

function stringifyBundle(bundle) {
  var json = JSON.stringify(bundle);
  return json.replace(/<[\/!]/g, function(match) {
    // Replace the end tag sequence with an equivalent JSON string to make
    // sure the script is not prematurely closed
    if (match === '</') return '<\\/';
    // Replace the start of an HTML comment tag sequence with an equivalent
    // JSON string
    if (match === '<!') return '<\\u0021';
    throw new Error('Unexpected match when escaping JSON');
  });
}

// TODO: Cleanup; copied from tracks
function pageParams(req) {
  var params = {
    url: req.url
  , body: req.body
  , query: req.query
  };
  for (var key in req.params) {
    params[key] = req.params[key];
  }
  return params;
}
