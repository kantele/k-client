/*
 * App.js
 *
 * Provides the glue between views, controllers, and routes for an
 * application's functionality. Apps are responsible for creating pages.
 *
 */

var EventEmitter = require('events').EventEmitter;
var tracks = require('k-tracks');
var util = require('k-model/lib/util');
var derbyTemplates = require('k-templates');
var documentListeners = require('./documentListeners');
var Page = require('./Page');
var serializedViews = require('./_views');

module.exports = App;

function App(derby, name, filename) {
  EventEmitter.call(this);
  this.derby = derby;
  this.name = name;
  this.filename = filename;
  this.scriptHash = '{{DERBY_SCRIPT_HASH}}';
  this.bundledAt = '{{DERBY_BUNDLED_AT}}';
  this.Page = createAppPage();
  this.proto = this.Page.prototype;
  this.views = new derbyTemplates.templates.Views();
  this.tracksRoutes = tracks.setup(this);
  this.model = null;
  this.page = null;
  this.scrollY = {};
  this.on('routeDone', this.onRouteDone);
  this._init();
}

function createAppPage() {
  // Inherit from Page so that we can add controller functions as prototype
  // methods on this app's pages
  function AppPage() {
    Page.apply(this, arguments);
  }
  AppPage.prototype = Object.create(Page.prototype);
  return AppPage;
}

util.mergeInto(App.prototype, EventEmitter.prototype);

// Overriden on server
App.prototype._init = function() {
  this._waitForAttach = true;
  this._cancelAttach = false;
  this.model = new this.derby.Model();
  serializedViews(derbyTemplates, this.views);
  // Must init async so that app.on('model') listeners can be added.
  // Must also wait for content ready so that bundle is fully downloaded.
  this._contentReady();
};
App.prototype._finishInit = function() {
  var script = this._getScript();
  var data = JSON.parse(script.nextSibling.innerHTML);
  this.model.createConnection(data);
  this.emit('model', this.model);
  util.isProduction = data.nodeEnv === 'production';
  if (!util.isProduction) this._autoRefresh();
  this.model.unbundle(data);
  var page = this.createPage();
  page.params = this.model.get('$render.params');
  this.emit('ready', page);
  this._waitForAttach = false;
  // Instead of attaching, do a route and render if a link was clicked before
  // the page finished attaching
  if (this._cancelAttach) {
    this.history.refresh();
    return;
  }
  // Since an attachment failure is *fatal* and could happen as a result of a
  // browser extension like AdBlock, an invalid template, or a small bug in
  // Derby or Saddle, re-render from scratch on production failures
  if (util.isProduction) {
    try {
      page.attach();
    } catch (err) {
      this.history.refresh();
      console.warn('attachment error', err.stack);
    }
  } else {
    page.attach();
  }
  this.emit('load', page);
};
// Modified from: https://github.com/addyosmani/jquery.parts/blob/master/jquery.documentReady.js
App.prototype._contentReady = function() {
  // Is the DOM ready to be used? Set to true once it occurs.
  var isReady = false;
  var app = this;

  // The ready event handler
  function onDOMContentLoaded() {
    if (document.addEventListener) {
      document.removeEventListener('DOMContentLoaded', onDOMContentLoaded, false);
    } else {
      // we're here because readyState !== 'loading' in oldIE
      // which is good enough for us to call the dom ready!
      document.detachEvent('onreadystatechange', onDOMContentLoaded);
    }
    onDOMReady();
  }

  // Handle when the DOM is ready
  function onDOMReady() {
    // Make sure that the DOM is not already loaded
    if (isReady) return;
    // Make sure body exists, at least, in case IE gets a little overzealous (ticket #5443).
    if (!document.body) return setTimeout(onDOMReady, 0);
    // Remember that the DOM is ready
    isReady = true;
    // Make sure this is always async and then finishin init
    setTimeout(function() {
      try {
        app._finishInit();
      }
      catch (e) {
        // todo: we may want to do something with this, i.e. send to log. provide a method
        console.log(e);
      }
    }, 0);
  }

  // The DOM ready check for Internet Explorer
  function doScrollCheck() {
    if (isReady) return;
    try {
      // If IE is used, use the trick by Diego Perini
      // http://javascript.nwbox.com/IEContentLoaded/
      document.documentElement.doScroll('left');
    } catch (err) {
      setTimeout(doScrollCheck, 0);
      return;
    }
    // and execute any waiting functions
    onDOMReady();
  }

  // Catch cases where called after the browser event has already occurred.
  if (document.readyState !== 'loading') return onDOMReady();

  // Mozilla, Opera and webkit nightlies currently support this event
  if (document.addEventListener) {
    // Use the handy event callback
    document.addEventListener('DOMContentLoaded', onDOMContentLoaded, false);
    // A fallback to window.onload, that will always work
    window.addEventListener('load', onDOMContentLoaded, false);
    // If IE event model is used
  } else if (document.attachEvent) {
    // ensure firing before onload,
    // maybe late but safe also for iframes
    document.attachEvent('onreadystatechange', onDOMContentLoaded);
    // A fallback to window.onload, that will always work
    window.attachEvent('onload', onDOMContentLoaded);
    // If IE and not a frame
    // continually check to see if the document is ready
    var toplevel;
    try {
      toplevel = window.frameElement == null;
    } catch (err) {}
    if (document.documentElement.doScroll && toplevel) {
      doScrollCheck();
    }
  }
};

App.prototype._getScript = function() {
  return document.querySelector('script[src*="/k-client/' + this.name + '"]');
};

App.prototype.use = util.use;
App.prototype.serverUse = util.serverUse;

App.prototype.loadViews = function() {};

App.prototype.loadStyles = function() {};

App.prototype.createPage = function() {
  if (this.page) {
    this.emit('destroyPage', this.page);
    this.page.destroy();
  }
  var page = new this.Page(this, this.model);
  this.page = page;
  return page;
};

App.prototype.onRoute = function(callback, page, next, done) {
  // Store the scroll position of the page we are leaving
  // in case we get back to it with the back button
  if (typeof window !== 'undefined' && page && page.params && page.params.previous) {
    this.scrollY[page.params.previous] = window.scrollY;
  }

  if (this._waitForAttach) {
    // Cancel any routing before the initial page attachment. Instead, do a
    // render once derby is ready
    this._cancelAttach = true;
    return;
  }
  this.emit('route', page);
  // HACK: To update render in transitional routes
  page.model.set('$render.params', page.params);
  page.model.set('$render.url', page.params.url);
  page.model.set('$render.query', page.params.query);
  // If transitional
  if (done) {
    var app = this;
    var _done = function() {
      app.emit('routeDone', page, 'transition');
      done();
    };
    callback.call(page, page, page.model, page.params, next, _done);
    return;
  }
  if (this.model) this.model._queries.reConstruct(page.model);
  callback.call(page, page, page.model, page.params, next);
};

App.prototype._autoRefresh = function() {
  var app = this;
  var connection = this.model.connection;
  connection.on('connected', function() {
    connection.send({
      derby: 'app',
      name: app.name,
      hash: app.scriptHash
    });
  });
  connection.on('receive', function(request) {
    if (request.data.derby) {
      var message = request.data;
      request.data = null;
      app._handleMessage(message.derby, message);
    }
  });
};

App.prototype._handleMessage = function(action, message) {
  if (action === 'refreshViews') {
    var fn = new Function('return ' + message.views)(); // jshint ignore:line
    fn(derbyTemplates, this.views);
    var ns = this.model.get('$render.ns');
    this.page.render(ns);

  } else if (action === 'refreshStyles') {
    var styleElement = document.querySelector('style[data-filename="' +
      message.filename + '"]');
    if (styleElement) styleElement.innerHTML = message.css;

  } else if (action === 'reload') {
    this.model.whenNothingPending(function() {
      window.location = window.location;
    });
  }
};

App.prototype.onRouteDone = function(app) {
  if (app && app.page && app.page.params && !app.page.params.disableScrolling) {
    if (typeof window !== 'undefined' && (app.page && app.page.params)) {
      if (app.page.params.backbutton && this.scrollY[app.page.params.url]) {
        window.scroll(0, this.scrollY[app.page.params.url]);
        delete(this.scrollY[app.page.params.url]);
      }
      else {
        if (app.page.params.hash) {
          var el = document.getElementById(app.page.params.hash.substring(1));
          if (el) {
            el.scrollIntoView(true);
          }
        }
        else {
          window.scrollTo(0, 0);
        }
      }
    }
  }
};

util.serverRequire(module, './App.server');
