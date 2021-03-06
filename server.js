var camp = require('camp').start({
  documentRoot: __dirname,
  port: +process.env.PORT||+process.argv[2]||80
});
var https = require('https');
var http = require('http');
var request = require('request');
var fs = require('fs');
var badge = require('./badge.js');
var svg2img = require('./svg-to-img.js');
var serverStartTime = new Date((new Date()).toGMTString());

// Analytics

var analytics = {};

var analyticsAutoSaveFileName = './analytics.json';
var analyticsAutoSavePeriod = 10000;
setInterval(function analyticsAutoSave() {
  fs.writeFile(analyticsAutoSaveFileName, JSON.stringify(analytics));
}, analyticsAutoSavePeriod);

// Auto-load analytics.
function analyticsAutoLoad() {
  try {
    analytics = JSON.parse(fs.readFileSync(analyticsAutoSaveFileName));
  } catch(e) {
    // In case something happens on the 36th.
    analytics.vendorMonthly = new Array(36);
    analytics.rawMonthly = new Array(36);
    resetMonthlyAnalytics(analytics.vendorMonthly);
    resetMonthlyAnalytics(analytics.rawMonthly);
  }
}

var lastDay = (new Date()).getDate();
function resetMonthlyAnalytics(monthlyAnalytics) {
  for (var i = 0; i < monthlyAnalytics.length; i++) {
    monthlyAnalytics[i] = 0;
  }
}
function incrMonthlyAnalytics(monthlyAnalytics) {
  var currentDay = (new Date()).getDate();
  // If we changed month, reset empty days.
  while (lastDay !== currentDay) {
    // Assumption: at least a hit a month.
    lastDay = (lastDay + 1) % monthlyAnalytics.length;
    monthlyAnalytics[lastDay] = 0;
  }
  monthlyAnalytics[currentDay]++;
}

analyticsAutoLoad();
camp.ajax.on('analytics/v1', function(json, end) { end(analytics); });

// Cache

var cacheTimeout = 60000;   // 1 minute.
var cacheFromIndex = Object.create(null);

function cache(f) {
  return function getRequest(data, match, end, ask) {
    // Cache management - no cache, so it won't be cached by GitHub's CDN.
    ask.res.setHeader('Cache-Control', 'no-cache, no-store, must-revalidate');
    incrMonthlyAnalytics(analytics.vendorMonthly);

    var cacheIndex = match[0] + '?label=' + data.label;
    // Should we return the data right away?
    var cached = cacheFromIndex[cacheIndex];
    if (cached != null) {
      badge(cached.badgeData, makeSend(cached.format, ask.res, end));
      return;
    }

    f(data, match, function sendBadge(format, badgeData) {
      cacheFromIndex[cacheIndex] = { format: format, badgeData: badgeData };
      setTimeout(function clearCache() {
        delete cacheFromIndex[cacheIndex];
      }, cacheTimeout);
      badge(badgeData, makeSend(format, ask.res, end));
    });
  };
}

// Vendors.

// Travis integration
camp.route(/^\/travis(-ci)?\/([^\/]+\/[^\/]+)(?:\/(.+))?\.(svg|png|gif|jpg)$/,
cache(function(data, match, sendBadge) {
  var userRepo = match[2];
  var branch = match[3];
  var format = match[4];
  var options = {
    json: true,
    uri: 'https://api.travis-ci.org/repositories/' + userRepo
  };
  if (branch) {
    options.uri += '/branches/' + branch;
  }
  options.uri += '.json';
  var badgeData = getBadgeData('build', data);
  request(options, function(err, res, json) {
    if (err != null) {
      badgeData.text[1] = 'inaccessible';
      sendBadge(format, badgeData);
      return;
    }
    // Using last_build_status (eg, not a branch).
    if (json.last_build_status != null) {
      json.branch = {state: 'pending'};
      if (json.last_build_status === 0) {
        json.branch.state = 'passing';
      } else if (json.last_build_status === 1) {
        json.branch.state = 'failing';
      }
    }
    if (!json.branch || !json.branch.state) {
      badgeData.text[1] = 'unknown';
      sendBadge(format, badgeData);
      return;
    }
    var state = json.branch.state;
    var substate = state.slice(0, 4);
    badgeData.text[1] = state;
    if (substate === 'pass') {
      badgeData.colorscheme = 'brightgreen';
    } else if (substate === 'fail') {
      badgeData.colorscheme = 'red';
    } else {
      badgeData.text[1] = 'pending';
    }
    sendBadge(format, badgeData);
  });
}));

// Gittip integration.
camp.route(/^\/gittip\/(.*)\.(svg|png|gif|jpg)$/,
cache(function(data, match, sendBadge) {
  var user = match[1];  // eg, `JSFiddle`.
  var format = match[2];
  var apiUrl = 'https://www.gittip.com/' + user + '/public.json';
  var badgeData = getBadgeData('tips', data);
  request(apiUrl, function dealWithData(err, res, buffer) {
    if (err != null) {
      badgeData.text[1] = 'inaccessible';
      sendBadge(format, badgeData);
      return;
    }
    try {
      var data = JSON.parse(buffer);
      var money = parseInt(data.receiving);
      badgeData.text[1] = '$' + metric(money) + '/week';
      if (money === 0) {
        badgeData.colorscheme = 'red';
      } else if (money < 10) {
        badgeData.colorscheme = 'yellow';
      } else if (money < 100) {
        badgeData.colorscheme = 'green';
      } else {
        badgeData.colorscheme = 'brightgreen';
      }
      sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'invalid';
      sendBadge(format, badgeData);
    }
  });
}));

// Packagist integration.
camp.route(/^\/packagist\/dm\/(.*)\.(svg|png|gif|jpg)$/,
cache(function(data, match, sendBadge) {
  var userRepo = match[1];  // eg, `doctrine/orm`.
  var format = match[2];
  var apiUrl = 'https://packagist.org/packages/' + userRepo + '.json';
  var badgeData = getBadgeData('downloads', data);
  request(apiUrl, function(err, res, buffer) {
    if (err != null) {
      badgeData.text[1] = 'inaccessible';
      sendBadge(format, badgeData);
    }
    try {
      var data = JSON.parse(buffer);
      var monthly = data.package.downloads.monthly;
      badgeData.text[1] = metric(monthly) + '/month';
      if (monthly === 0) {
        badgeData.colorscheme = 'red';
      } else if (monthly < 10) {
        badgeData.colorscheme = 'yellow';
      } else if (monthly < 100) {
        badgeData.colorscheme = 'yellowgreen';
      } else if (monthly < 1000) {
        badgeData.colorscheme = 'green';
      } else {
        badgeData.colorscheme = 'brightgreen';
      }
      sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'invalid';
      sendBadge(format, badgeData);
    }
  });
}));

// Packagist version integration.
camp.route(/^\/packagist\/v\/(.*)\.(svg|png|gif|jpg)$/,
cache(function(data, match, sendBadge) {
  var userRepo = match[1];
  var format = match[2];
  var apiUrl = 'https://packagist.org/packages/' + userRepo + '.json';
  var badgeData = getBadgeData('packagist', data);
  request(apiUrl, function(err, res, buffer) {
    if (err != null) {
      badgeData.text[1] = 'inaccessible';
      sendBadge(format, badgeData);
    }
    try {
      var data = JSON.parse(buffer);
      var version;
      var unstable = function(ver) {
        return /dev/.test(ver);
      };
      // Grab the latest stable version, or an unstable
      for (var v in data.package.versions) {
        v = data.package.versions[v];

        if (version) {
          if (/dev/.test(version.version) && !/dev/.test(v.version)) {
            version = v;
          } else if (version.version_normalized < v.version_normalized) {
            version = v;
          }
        } else {
          version = v;
        }
      }
      version = version.version.replace(/^v/, "");
      badgeData.text[1] = version;
      if (/^\d/.test(badgeData.text[1])) {
        badgeData.text[1] = 'v' + version;
      }
      if (version[0] === '0' || /dev/.test(version)) {
        badgeData.colorscheme = 'orange';
      } else {
        badgeData.colorscheme = 'blue';
      }
      sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'invalid';
      sendBadge(format, badgeData);
    }
  });
}));

// npm integration.
camp.route(/^\/npm\/dm\/(.*)\.(svg|png|gif|jpg)$/,
cache(function(data, match, sendBadge) {
  var user = match[1];  // eg, `localeval`.
  var format = match[2];
  var apiUrl = 'https://api.npmjs.org/downloads/point/last-month/' + user;
  var badgeData = getBadgeData('downloads', data);
  request(apiUrl, function(err, res, buffer) {
    if (err != null) {
      console.log(err);
      badgeData.text[1] = 'inaccessible';
      sendBadge(format, badgeData);
      return;
    }
    try {
      var monthly = JSON.parse(buffer).downloads;
    } catch(e) {
      badgeData.text[1] = 'invalid';
      sendBadge(format, badgeData);
      return;
    }
    badgeData.text[1] = metric(monthly) + '/month';
    if (monthly === 0) {
      badgeData.colorscheme = 'red';
    } else if (monthly < 10) {
      badgeData.colorscheme = 'yellow';
    } else if (monthly < 100) {
      badgeData.colorscheme = 'yellowgreen';
    } else if (monthly < 1000) {
      badgeData.colorscheme = 'green';
    } else {
      badgeData.colorscheme = 'brightgreen';
    }
    sendBadge(format, badgeData);
  });
}));

// npm version integration.
camp.route(/^\/npm\/v\/(.*)\.(svg|png|gif|jpg)$/,
cache(function(data, match, sendBadge) {
  var repo = match[1];  // eg, `localeval`.
  var format = match[2];
  var apiUrl = 'https://registry.npmjs.org/' + repo + '/latest';
  var badgeData = getBadgeData('npm', data);
  request(apiUrl, function(err, res, buffer) {
    if (err != null) {
      badgeData.text[1] = 'inaccessible';
      sendBadge(format, badgeData);
    }
    try {
      var data = JSON.parse(buffer);
      var version = data.version;
      badgeData.text[1] = 'v' + version;
      if (version[0] === '0' || /dev/.test(version)) {
        badgeData.colorscheme = 'orange';
      } else {
        badgeData.colorscheme = 'blue';
      }
      sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'invalid';
      sendBadge(format, badgeData);
    }
  });
}));

// Gem version integration.
camp.route(/^\/gem\/v\/(.*)\.(svg|png|gif|jpg)$/,
cache(function(data, match, sendBadge) {
  var repo = match[1];  // eg, `localeval`.
  var format = match[2];
  var apiUrl = 'https://rubygems.org/api/v1/gems/' + repo + '.json';
  var badgeData = getBadgeData('gem', data);
  request(apiUrl, function(err, res, buffer) {
    if (err != null) {
      badgeData.text[1] = 'inaccessible';
      sendBadge(format, badgeData);
    }
    try {
      var data = JSON.parse(buffer);
      var version = data.version;
      badgeData.text[1] = 'v' + version;
      if (version[0] === '0' || /dev/.test(version)) {
        badgeData.colorscheme = 'orange';
      } else {
        badgeData.colorscheme = 'blue';
      }
      sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'invalid';
      sendBadge(format, badgeData);
    }
  });
}));

// PyPI integration.
camp.route(/^\/pypi\/([^\/]+)\/(.*)\.(svg|png|gif|jpg)$/,
cache(function(data, match, sendBadge) {
  var info = match[1];
  var egg = match[2];  // eg, `gevent`.
  var format = match[3];
  var apiUrl = 'https://pypi.python.org/pypi/' + egg + '/json';
  var badgeData = getBadgeData('pypi', data);
  request(apiUrl, function(err, res, buffer) {
    if (err != null) {
      badgeData.text[1] = 'inaccessible';
      sendBadge(format, badgeData);
    }
    try {
      var data = JSON.parse(buffer);
      if (info === 'dm') {
        badgeData.text[0] = getLabel('downloads', data);
        var monthly = data.info.downloads.last_month;
        badgeData.text[1] = metric(monthly) + '/month';
        if (monthly === 0) {
          badgeData.colorscheme = 'red';
        } else if (monthly < 10) {
          badgeData.colorscheme = 'yellow';
        } else if (monthly < 100) {
          badgeData.colorscheme = 'yellowgreen';
        } else if (monthly < 1000) {
          badgeData.colorscheme = 'green';
        } else {
          badgeData.colorscheme = 'brightgreen';
        }
        sendBadge(format, badgeData);
      } else if (info === 'v') {
        var version = data.info.version;
        badgeData.text[1] = 'v' + version;
        if (version[0] === '0' || /dev/.test(version)) {
          badgeData.colorscheme = 'orange';
        } else {
          badgeData.colorscheme = 'blue';
        }
        sendBadge(format, badgeData);
      }
    } catch(e) {
      badgeData.text[1] = 'invalid';
      sendBadge(format, badgeData);
    }
  });
}));

// Coveralls integration.
camp.route(/^\/coveralls\/([^\/]+\/[^\/]+)(?:\/(.+))?\.(svg|png|gif|jpg)$/,
cache(function(data, match, sendBadge) {
  var userRepo = match[1];  // eg, `jekyll/jekyll`.
  var branch = match[2];
  var format = match[3];
  var apiUrl = 'https://coveralls.io/repos/' + userRepo + '/badge.png';
  if (branch) {
    apiUrl += '?branch=' + branch;
  }
  var badgeData = getBadgeData('coverage', data);
  https.get(apiUrl, function(res) {
    // We should get a 302. Look inside the Location header.
    var buffer = res.headers.location;
    if (!buffer) {
      badgeData.text[1] = 'invalid';
      sendBadge(format, badgeData);
      return;
    }
    try {
      var score = buffer.split('_')[1].split('.')[0];
      var percentage = parseInt(score);
      if (percentage !== percentage) {
        // It is NaN, treat it as unknown.
        badgeData.text[1] = 'unknown';
        sendBadge(format, badgeData);
        return;
      }
    } catch(e) {
      badgeData.text[1] = 'malformed';
      sendBadge(format, badgeData);
      return;
    }
    badgeData.text[1] = score + '%';
    if (percentage < 80) {
      badgeData.colorscheme = 'red';
    } else if (percentage < 90) {
      badgeData.colorscheme = 'yellow';
    } else if (percentage < 95) {
      badgeData.colorscheme = 'green';
    } else {
      badgeData.colorscheme = 'brightgreen';
    }
    sendBadge(format, badgeData);
  }).on('error', function(e) {
    badgeData.text[1] = 'inaccessible';
    sendBadge(format, badgeData);
  });
}));

// Code Climate integration
camp.route(/^\/codeclimate\/(.+)\.(svg|png|gif|jpg)$/,
cache(function(data, match, sendBadge) {
  var userRepo = match[1];  // eg, `github/kabisaict/flow`.
  var format = match[2];
  var options = {
    method: 'HEAD',
    uri: 'https://codeclimate.com/' + userRepo + '.png'
  };
  var badgeData = getBadgeData('code climate', data);
  request(options, function(err, res) {
    if (err != null) {
      badgeData.text[1] = 'inaccessible';
      sendBadge(format, badgeData);
    }
    try {
      var statusMatch = res.headers['content-disposition']
                           .match(/filename="code_climate-(.+)\.png"/);
      if (!statusMatch) {
        badgeData.text[1] = 'unknown';
        sendBadge(format, badgeData);
        return;
      }
      var state = statusMatch[1].replace('-', '.');
      var score = +state;
      badgeData.text[1] = state;
      if (score == 4) {
        badgeData.colorscheme = 'brightgreen';
      } else if (score > 3) {
        badgeData.colorscheme = 'green';
      } else if (score > 2) {
        badgeData.colorscheme = 'yellowgreen';
      } else if (score > 1) {
        badgeData.colorscheme = 'yellow';
      } else {
        badgeData.colorscheme = 'red';
      }
      sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'not found';
      sendBadge(format, badgeData);
    }
  });
}));

// Code Climate integration
camp.route(/^\/gemnasium\/(.+)\.(svg|png|gif|jpg)$/,
cache(function(data, match, sendBadge) {
  var userRepo = match[1];  // eg, `jekyll/jekyll`.
  var format = match[2];
  var options = {
    method: 'HEAD',
    uri: 'https://gemnasium.com/' + userRepo + '.png'
  };
  var badgeData = getBadgeData('dependencies', data);
  request(options, function(err, res) {
    if (err != null) {
      badgeData.text[1] = 'inaccessible';
      sendBadge(format, badgeData);
    }
    try {
      var statusMatch = res.headers['content-disposition']
                           .match(/filename="(.+)\.png"/);
      if (!statusMatch) {
        badgeData.text[1] = 'unknown';
        sendBadge(format, badgeData);
      }
      // Either `dev-yellow` or `yellow`.
      var state = statusMatch[1].split('-');
      var color = state.pop();
      if (state[0] === 'dev') { badgeData.text[0] = 'devDependencies'; }
      if (color === 'green') {
        badgeData.text[1] = 'up-to-date';
        badgeData.colorscheme = 'brightgreen';
      } else if (color === 'yellow') {
        badgeData.text[1] = 'out-of-date';
        badgeData.colorscheme = 'yellow';
      } else if (color === 'red') {
        badgeData.text[1] = 'update!';
        badgeData.colorscheme = 'red';
      } else if (color === 'none') {
        badgeData.text[1] = 'none';
        badgeData.colorscheme = 'brightgreen';
      } else {
        badgeData.text[1] = 'undefined';
      }
      sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'invalid';
      sendBadge(format, badgeData);
      return;
    }
  });
}));

// Hackage version integration.
camp.route(/^\/hackage\/v\/(.*)\.(svg|png|gif|jpg)$/,
cache(function(data, match, sendBadge) {
  var repo = match[1];  // eg, `lens`.
  var format = match[2];
  var apiUrl = 'https://hackage.haskell.org/package/' + repo + '/' + repo + '.cabal';
  var badgeData = getBadgeData('hackage', data);
  request(apiUrl, function(err, res, buffer) {
    if (err != null) {
      badgeData.text[1] = 'inaccessible';
      sendBadge(format, badgeData);
    }
    try {
      var lines = buffer.split("\n");
      var versionLines = lines.filter(function(e) {
        return (/^version:/i).test(e) === true;
      });
      // We don't have to check length of versionLines, because if we throw,
      // we'll render the 'invalid' badge below, which is the correct thing
      // to do.
      var version = versionLines[0].replace(/\s+/, '').split(/:/)[1];
      badgeData.text[1] = 'v' + version;
      if (version[0] === '0') {
        badgeData.colorscheme = 'orange';
      } else {
        badgeData.colorscheme = 'blue';
      }
      sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'invalid';
      sendBadge(format, badgeData);
    }
  });
}));

// CocoaPods version integration.
camp.route(/^\/cocoapods\/v\/(.*)\.(svg|png|gif|jpg)$/,
cache(function(data, match, sendBadge) {
  var spec = match[1];
  var format = match[2];
  var apiUrl = 'http://search.cocoapods.org/api/v1/pod/' + spec + '.json';
  var badgeData = getBadgeData('pod', data);
  request(apiUrl, function(err, res, buffer) {
    if (err != null) {
      badgeData.text[1] = 'inaccessible';
      sendBadge(format, badgeData);
    }
    try {
      var data = JSON.parse(buffer);
      var version = data.version;
      version = version.replace(/^v/, "");
      badgeData.text[1] = version;
      if (/^\d/.test(badgeData.text[1])) {
        badgeData.text[1] = 'v' + version;
      }
      if (version[0] === '0' || /dev/.test(version)) {
        badgeData.colorscheme = 'orange';
      } else {
        badgeData.colorscheme = 'blue';
      }
      sendBadge(format, badgeData);
    } catch(e) {
      badgeData.text[1] = 'invalid';
      sendBadge(format, badgeData);
    }
  });
}));

// Any badge.
camp.route(/^\/(:|badge\/)(([^-]|--)+)-(([^-]|--)+)-(([^-]|--)+)\.(svg|png|gif|jpg)$/,
function(data, match, end, ask) {
  var subject = escapeFormat(match[2]);
  var status = escapeFormat(match[4]);
  var color = escapeFormat(match[6]);
  var format = match[8];

  incrMonthlyAnalytics(analytics.rawMonthly);

  // Cache management - the badge is constant.
  var cacheDuration = (3600*24*1)|0;    // 1 day.
  ask.res.setHeader('Cache-Control', 'public, max-age=' + cacheDuration);
  if (+(new Date(ask.req.headers['if-modified-since'])) >= +serverStartTime) {
    ask.res.statusCode = 304;
    ask.res.end();  // not modified.
    return;
  }
  ask.res.setHeader('Last-Modified', serverStartTime.toGMTString());

  // Badge creation.
  try {
    var badgeData = {text: [subject, status]};
    if (sixHex(color)) {
      badgeData.colorB = '#' + color;
    } else {
      badgeData.colorscheme = color;
    }
    badge(badgeData, makeSend(format, ask.res, end));
  } catch(e) {
    badge({text: ['error', 'bad badge'], colorscheme: 'red'},
      makeSend(format, ask.res, end));
  }
});

// Any badge, old version.
camp.route(/^\/([^\/]+)\/(.+).png$/,
function(data, match, end, ask) {
  var subject = match[1];
  var status = match[2];
  var color = data.color;

  // Cache management - the badge is constant.
  var cacheDuration = (3600*24*1)|0;    // 1 day.
  ask.res.setHeader('Cache-Control', 'public, max-age=' + cacheDuration);
  if (+(new Date(ask.req.headers['if-modified-since'])) >= +serverStartTime) {
    ask.res.statusCode = 304;
    ask.res.end();  // not modified.
    return;
  }
  ask.res.setHeader('Last-Modified', serverStartTime.toGMTString());

  // Badge creation.
  try {
    var badgeData = {text: [subject, status]};
    badgeData.colorscheme = color;
    badge(badgeData, makeSend('png', ask.res, end));
  } catch(e) {
    badge({text: ['error', 'bad badge'], colorscheme: 'red'},
      makeSend('png', ask.res, end));
  }
});

// Redirect the root to the website.
camp.route(/^\/$/, function(data, match, end, ask) {
  ask.res.statusCode = 302;
  ask.res.setHeader('Location', 'http://shields.io');
  ask.res.end();
});

// Escapes `t` using the format specified in
// <https://github.com/espadrine/gh-badges/issues/12#issuecomment-31518129>
function escapeFormat(t) {
  return t
    // Inline single underscore.
    .replace(/([^_])_([^_])/g, '$1 $2')
    // Leading or trailing underscore.
    .replace(/([^_])_$/, '$1 ').replace(/^_([^_])/, ' $1')
    // Double underscore and double dash.
    .replace(/__/g, '_').replace(/--/g, '-');
}

function sixHex(s) { return /^[0-9a-fA-F]{6}$/.test(s); }

function getLabel(label, data) {
  return data.label || label;
}

function getBadgeData(defaultLabel, data) {
  var label = getLabel(defaultLabel, data);
  return {text:[label, 'n/a'], colorscheme:'lightgrey'};
}

function makeSend(format, askres, end) {
  if (format === 'svg') {
    return function(res) { sendSVG(res, askres, end); };
  } else {
    return function(res) { sendOther(format, res, askres, end); };
  }
}

function sendSVG(res, askres, end) {
  askres.setHeader('Content-Type', 'image/svg+xml;charset=utf-8');
  end(null, {template: streamFromString(res)});
}

function sendOther(format, res, askres, end) {
  askres.setHeader('Content-Type', 'image/' + format);
  svg2img(res, format, askres);
}

var stream = require('stream');
function streamFromString(str) {
  var newStream = new stream.Readable();
  newStream._read = function() { newStream.push(str); newStream.push(null); };
  return newStream;
}

// Given a number, string with appropriate unit in the metric system, SI.
function metric(n) {
  var limit = 1000;
  if (n > limit) {
    n = Math.round(n / 1000);
    return ''+n + 'k';
  } else {
    return ''+n;
  }
}
