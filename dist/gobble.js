'use strict';

var path = require('path');
var sander = require('sander');
var chalk = require('chalk');
var pathwatcher = require('pathwatcher');
var debounce = require('debounce');
var mapSeries = require('promise-map-series');
var eventemitter2 = require('eventemitter2');
var crc32 = require('buffer-crc32');
crc32 = 'default' in crc32 ? crc32['default'] : crc32;
var requireRelative = require('require-relative');
var util = require('util');
var http = require('http');
var tinyLr = require('tiny-lr');
var minimatch = require('minimatch');
var url$1 = require('url');
var mime = require('mime');
var gracefulFs = require('graceful-fs');

var babelHelpers_inherits = function (subClass, superClass) {
  if (typeof superClass !== "function" && superClass !== null) {
    throw new TypeError("Super expression must either be null or a function, not " + typeof superClass);
  }

  subClass.prototype = Object.create(superClass && superClass.prototype, {
    constructor: {
      value: subClass,
      enumerable: false,
      writable: true,
      configurable: true
    }
  });
  if (superClass) Object.setPrototypeOf ? Object.setPrototypeOf(subClass, superClass) : subClass.__proto__ = superClass;
};

var babelHelpers_classCallCheck = function (instance, Constructor) {
  if (!(instance instanceof Constructor)) {
    throw new TypeError("Cannot call a class as a function");
  }
};

function include(inputdir, outputdir, options) {
	var numPatterns = options.patterns.length;

	return sander.lsr(inputdir).then(function (files) {
		return files.filter(function (file) {
			var isIncluded = matches(file);
			return options.exclude ? !isIncluded : isIncluded;
		});
	}).then(function (files) {
		var promises = files.map(function (file) {
			return sander.mkdir(outputdir, path.dirname(file)).then(function () {
				return sander.symlinkOrCopy(inputdir, file).to(outputdir, file);
			});
		});

		return sander.Promise.all(promises);
	});

	function matches(filename) {
		var i = numPatterns;
		while (i--) {
			if (minimatch(filename, options.patterns[i])) {
				return true;
			}
		}

		return false;
	}
}

var Queue = (function (_EventEmitter2) {
	babelHelpers_inherits(Queue, _EventEmitter2);

	function Queue() {
		babelHelpers_classCallCheck(this, Queue);

		_EventEmitter2.call(this, { wildcard: true });

		var queue = this;

		queue._tasks = [];

		queue._run = function () {
			var task = queue._tasks.shift();

			if (!task) {
				queue._running = false;
				return;
			}

			task.promise.then(runOnNextTick, runOnNextTick);

			try {
				task.fn(task.fulfil, task.reject);
			} catch (err) {
				task.reject(err);

				queue.emit('error', err);
				runOnNextTick();
			}
		};

		function runOnNextTick() {
			process.nextTick(queue._run);
		}
	}

	Queue.prototype.add = function add(fn) {
		var task = undefined;

		var promise = new sander.Promise(function (fulfil, reject) {
			task = { fn: fn, fulfil: fulfil, reject: reject };
		});

		task.promise = promise;
		this._tasks.push(task);

		if (!this._running) {
			this._running = true;
			this._run();
		}

		return promise;
	};

	Queue.prototype.abort = function abort() {
		this._tasks = [];
		this._running = false;
	};

	return Queue;
})(eventemitter2.EventEmitter2);

function assign(target) {
	for (var _len = arguments.length, sources = Array(_len > 1 ? _len - 1 : 0), _key = 1; _key < _len; _key++) {
		sources[_key - 1] = arguments[_key];
	}

	sources.forEach(function (source) {
		var key = undefined;

		for (key in source) {
			if (source.hasOwnProperty(key)) {
				target[key] = source[key];
			}
		}
	});

	return target;
}

var config = {
	env: process.env.GOBBLE_ENV || 'development',
	cwd: process.env.GOBBLE_CWD || process.cwd()
};

function extractLocationInfo(err) {
	var file = err.file;
	var line = err.line;
	var column = err.column;
	var message = err.message;
	var loc = err.loc;

	if (!file && err.filename) {
		file = err.filename;
	}

	if (line === undefined && column === undefined && loc) {
		line = loc.line;
		column = loc.column;
	}

	var match = undefined;

	if (line === undefined) {
		if (match = /line (\d+)/.exec(message)) {
			line = +match[1];
		}
	}

	if (column === undefined) {
		if (match = /column (\d+)/.exec(message)) {
			column = +match[1];
		}
	}

	// Handle errors from e.g. browserify
	// Unexpected token (123:456) while parsing /path/to/.gobble/12-derequire/1/app.js
	if (line === undefined && column === undefined) {
		var _match = /(\d+):(\d+)/.exec(message);

		if (_match) {
			line = _match[1];
			column = _match[2];
		}
	}

	return { file: file, line: line, column: column };
}

var toString = Object.prototype.toString;

function isRegExp(what) {
	return toString.call(what) === '[object RegExp]';
}

function isArray(thing) {
	return toString.call(thing) === '[object Array]';
}

function isString(thing) {
	return typeof thing === 'string';
}

var ABORTED = { aborted: true };

var SOURCEMAPPING_URL = 'sourceMa';
SOURCEMAPPING_URL += 'ppingURL';

var SOURCEMAP_COMMENT = new RegExp('\n*(?:' + ('\\/\\/[@#]\\s*' + SOURCEMAPPING_URL + '=([^\'"]+)|') + ( // js
'\\/\\*#?\\s*' + SOURCEMAPPING_URL + '=([^\'"]+)\\s\\+\\/)') + // css
'\\s*$', 'g');

function getSourcemapComment(url, ext) {
	if (ext === '.css') {
		return '\n/*# ' + SOURCEMAPPING_URL + '=' + url + ' */\n';
	}

	return '\n//# ' + SOURCEMAPPING_URL + '=' + url + '\n';
}

function map(inputdir, outputdir, options) {
	var _this = this;

	var changed = {};
	this.changes.forEach(function (change) {
		if (!change.removed) {
			changed[change.file] = true;
		}
	});

	return new sander.Promise(function (fulfil, reject) {
		var queue = new Queue();

		queue.once('error', reject);

		sander.lsr(inputdir).then(function (files) {
			var promises = files.map(function (filename) {
				if (_this.aborted) return;

				var ext = path.extname(filename);

				// change extension if necessary, e.g. foo.coffee -> foo.js
				var destname = options.ext && ~options.accept.indexOf(ext) ? filename.substr(0, filename.length - ext.length) + options.ext : filename;

				var src = path.join(inputdir, filename);
				var dest = path.join(outputdir, destname);

				// If this mapper only accepts certain extensions, and this isn't
				// one of them, just copy the file
				if (shouldSkip(options, ext, filename)) {
					return sander.symlinkOrCopy(src).to(dest);
				}

				// If this file *does* fall within this transformer's remit, but
				// hasn't changed, we just copy the cached file
				if (!changed[filename] && options.cache.hasOwnProperty(filename)) {
					return sander.symlinkOrCopy(options.cache[filename]).to(dest);
				}

				// Otherwise, we queue up a transformation
				return queue.add(function (fulfil, reject) {
					if (_this.aborted) {
						return reject(ABORTED);
					}

					// Create context object - this will be passed to transformers
					var context = {
						log: _this.log,
						env: config.env,
						src: src, dest: dest, filename: filename
					};

					var transformOptions = assign({}, options.fn.defaults, options.userOptions);

					delete transformOptions.accept;
					delete transformOptions.ext;

					return sander.readFile(src).then(function (buffer) {
						return buffer.toString(transformOptions.sourceEncoding);
					}).then(function (data) {
						if (_this.aborted) return reject(ABORTED);

						var result = undefined;

						try {
							result = options.fn.call(context, data, transformOptions);
						} catch (e) {
							var err = createTransformError(e, src, filename, _this.node);
							return reject(err);
						}

						var codepath = path.resolve(_this.cachedir, filename);

						var _processResult = processResult(result, data, src, dest, codepath);

						var code = _processResult.code;
						var map = _processResult.map;

						writeToCacheDir(code, map, codepath, dest).then(function () {
							return sander.symlinkOrCopy(codepath).to(dest);
						}).then(function () {
							return options.cache[filename] = codepath;
						}).then(fulfil);
					})['catch'](reject);
				})['catch'](function (err) {
					queue.abort();
					throw err;
				});
			});

			return sander.Promise.all(promises);
		}).then(function () {
			queue.off('error', reject);
			fulfil();
		}, reject);
	});
}

function processResult(result, original, src, dest, codepath) {
	if (typeof result === 'object' && 'code' in result) {
		// if a sourcemap was returned, use it
		if (result.map) {
			return {
				code: result.code.replace(SOURCEMAP_COMMENT, '') + getSourcemapComment(encodeURI(codepath + '.map'), path.extname(codepath)),
				map: processSourcemap(result.map, src, dest, original)
			};
		}

		// otherwise we might have an inline sourcemap
		else {
				return processInlineSourceMap(result.code, src, dest, original, codepath);
			}
	}

	if (typeof result === 'string') {
		return processInlineSourceMap(result, src, dest, original, codepath);
	}

	return { code: result, map: null };
}

function isDataURI(str) {
	return (/^data:/.test(str)
	); // TODO beef this up
}

function processInlineSourceMap(code, src, dest, original, codepath) {
	// if there's an inline sourcemap, process it
	var match = SOURCEMAP_COMMENT.exec(code);
	var map = null;

	if (match && isDataURI(match[1])) {
		match = /base64,(.+)$/.exec(match[1]);

		if (!match) {
			throw new Error('sourceMappingURL is not base64-encoded');
		}

		var json = atob(match[1]);

		map = processSourcemap(json, src, dest, original);
		code = code.replace(SOURCEMAP_COMMENT, '') + getSourcemapComment(encodeURI(codepath + '.map'), path.extname(codepath));
	}

	return { code: code, map: map };
}

function writeToCacheDir(code, map, codepath) {
	if (map) {
		return sander.Promise.all([sander.writeFile(codepath, code), sander.writeFile(codepath + '.map', JSON.stringify(map))]);
	} else {
		return sander.writeFile(codepath, code);
	}
}

function createTransformError(original, src, filename, node) {
	var err = typeof original === 'string' ? new Error(original) : original;

	var message = 'An error occurred while processing ' + chalk.magenta(src);
	var creator = undefined;

	if (creator = node.input._findCreator(filename)) {
		message += ' (this file was created by the ' + creator.id + ' transformation)';
	}

	var _extractLocationInfo = extractLocationInfo(err);

	var line = _extractLocationInfo.line;
	var column = _extractLocationInfo.column;

	err.file = src;
	err.line = line;
	err.column = column;

	return err;
}

function processSourcemap(map, src, dest, data) {
	if (typeof map === 'string') {
		map = JSON.parse(map);
	}

	if (!map) {
		return null;
	}

	map.file = dest;
	map.sources = [src];
	map.sourcesContent = [data];
	return map;
}

function shouldSkip(options, ext, filename) {
	var filter = undefined;

	if (filter = options.accept) {
		var i = undefined;

		for (i = 0; i < filter.length; i++) {
			var flt = filter[i];

			if (typeof flt === 'string' && flt === ext) {
				return false;
			} else if (isRegExp(flt) && flt.test(filename)) {
				return false;
			}
		}

		return true;
	}

	return false;
}

function atob(base64) {
	return new Buffer(base64, 'base64').toString('utf8');
}

function moveTo(inputdir, outputdir, options) {
	return sander.symlinkOrCopy(inputdir).to(outputdir, options.dest);
}

function grab(inputdir, outputdir, options) {
	return sander.symlinkOrCopy(inputdir, options.src).to(outputdir);
}

function GobbleError(data) {
	var prop;

	this.stack = new Error().stack;

	for (prop in data) {
		if (data.hasOwnProperty(prop)) {
			this[prop] = data[prop];
		}
	}
}

GobbleError.prototype = Object.create(Error.prototype);
GobbleError.prototype.constructor = GobbleError;
GobbleError.prototype.gobble = true;
GobbleError.prototype.name = 'GobbleError';

var alreadyWarned = {};
function warnOnce() {
	var warning = util.format.apply(null, arguments);

	if (!alreadyWarned[warning]) {
		console.log(warning);
		alreadyWarned[warning] = true;
	}
}

function compareBuffers(a, b) {
	var i = a.length;

	if (b.length !== i) {
		return false;
	}

	while (i--) {
		if (a[i] !== b[i]) {
			return false;
		}
	}

	return true;
}

function cleanup(dir) {
	return sander.mkdir(dir).then(function () {
		return sander.readdir(dir).then(function (files) {
			var promises = files.map(function (filename) {
				return sander.rimraf(dir, filename);
			});
			return sander.Promise.all(promises);
		});
	});
}

var currentSession = undefined;

var session = {
	config: null, // mutable

	create: function create(options) {
		if (currentSession) {
			throw new Error('Gobble is already running. You can only run one build/serve task per process');
		}

		session.config = {
			gobbledir: options.gobbledir
		};

		currentSession = new eventemitter2.EventEmitter2({ wildcard: true });
		return currentSession;
	},

	destroy: function destroy() {
		currentSession = session.config = null;
	}
};

function serveFile(filepath, request, response) {
	var ext = path.extname(filepath);

	// this might be turn out to be a really bad idea. But let's try it and see
	if (ext === '.js' || ext === '.css') {
		return sander.readFile(filepath).then(function (data) {
			// this takes the auto-generated absolute sourcemap path, and turns
			// it into what you'd get with `gobble build` or `gobble watch`
			var sourcemapComment = getSourcemapComment(path.basename(filepath) + '.map', ext);
			data = data.toString().replace(SOURCEMAP_COMMENT, sourcemapComment);

			response.statusCode = 200;
			response.setHeader('Content-Type', mime.lookup(filepath));

			response.write(data);
			response.end();
		});
	}

	return sander.stat(filepath).then(function (stats) {
		response.statusCode = 200;
		response.setHeader('Content-Type', mime.lookup(filepath));
		response.setHeader('Content-Length', stats.size);

		sander.createReadStream(filepath).pipe(response);
	});
}

function compile(string) {
	return function (data) {
		return string.replace(/\{\{([^\}]+)\}\}/g, function (match, $1) {
			return data.hasOwnProperty($1) ? data[$1] : match;
		});
	};
}

var dirTemplate = compile('<!DOCTYPE html>\n<html>\n\t<head>\n\t\t<title>{{url}}</title>\n\t\t<style>\n\t\t\tbody {\n\t\t\t\tfont-family: \'Helvetica Neue\', arial, sans-serif;\n\t\t\t\tcolor: #666;\n\t\t\t\tfont-weight: 200;\n\t\t\t\tline-height: 1.4;\n\t\t\t\tpadding: 0 1em;\n\t\t\t}\n\n\t\t\tmain {\n\t\t\t\tmax-width: 30em;\n\t\t\t\tmargin: 2em auto 1em auto;\n\t\t\t}\n\n\t\t\th1 {\n\t\t\t\tfont-weight: 100;\n\t\t\t\tfont-size: 2em;\n\t\t\t\tmargin: 0 0 1em 0;\n\t\t\t}\n\n\t\t\tul {\n\t\t\t\tpadding: 0;\n\t\t\t\tmargin: 0;\n\t\t\t\tlist-style: none;\n\t\t\t}\n\n\t\t\tli {\n\t\t\t\tbackground: no-repeat 0 3px;\n\t\t\t\tpadding: 6px 0 6px 30px;\n\t\t\t\tbackground-image: url(data:image/gif;base64,R0lGODlhFAAWAMIAAP///8z//5mZmTMzMwAAAAAAAAAAAAAAACH+TlRoaXMgYXJ0IGlzIGluIHRoZSBwdWJsaWMgZG9tYWluLiBLZXZpbiBIdWdoZXMsIGtldmluaEBlaXQuY29tLCBTZXB0ZW1iZXIgMTk5NQAh+QQBAAABACwAAAAAFAAWAAADaDi6vPEwDECrnSO+aTvPEQcIAmGaIrhR5XmKgMq1LkoMN7ECrjDWp52r0iPpJJ0KjUAq7SxLE+sI+9V8vycFiM0iLb2O80s8JcfVJJTaGYrZYPNby5Ov6WolPD+XDJqAgSQ4EUCGQQEJADs=);\n\t\t\t}\n\n\t\t\t/* public domain icons via http://www.apache.org/icons/ */\n\t\t\t.parent {\n\t\t\t\tbackground-image: url(data:image/gif;base64,R0lGODlhFAAWAMIAAP///8z//5mZmWZmZjMzMwAAAAAAAAAAACH+TlRoaXMgYXJ0IGlzIGluIHRoZSBwdWJsaWMgZG9tYWluLiBLZXZpbiBIdWdoZXMsIGtldmluaEBlaXQuY29tLCBTZXB0ZW1iZXIgMTk5NQAh+QQBAAABACwAAAAAFAAWAAADSxi63P4jEPJqEDNTu6LO3PVpnDdOFnaCkHQGBTcqRRxuWG0v+5LrNUZQ8QPqeMakkaZsFihOpyDajMCoOoJAGNVWkt7QVfzokc+LBAA7);\n\t\t\t\tpadding-bottom: 6px;\n\t\t\t\tmargin-bottom: 6px;\n\t\t\t\tborder-bottom: 1px solid #ddd;\n\t\t\t}\n\n\t\t\t.dir {\n\t\t\t\tbackground-image: url(data:image/gif;base64,R0lGODlhFAAWAMIAAP/////Mmcz//5lmMzMzMwAAAAAAAAAAACH+TlRoaXMgYXJ0IGlzIGluIHRoZSBwdWJsaWMgZG9tYWluLiBLZXZpbiBIdWdoZXMsIGtldmluaEBlaXQuY29tLCBTZXB0ZW1iZXIgMTk5NQAh+QQBAAACACwAAAAAFAAWAAADVCi63P4wyklZufjOErrvRcR9ZKYpxUB6aokGQyzHKxyO9RoTV54PPJyPBewNSUXhcWc8soJOIjTaSVJhVphWxd3CeILUbDwmgMPmtHrNIyxM8Iw7AQA7);\n\t\t\t}\n\n\t\t\t/* images */\n\t\t\t.png, .jpg, .gif {\n\t\t\t\tbackground-image: url(data:image/gif;base64,R0lGODlhFAAWAOMAAP////8zM8z//8zMzJmZmWZmZmYAADMzMwCZzACZMwAzZgAAAAAAAAAAAAAAAAAAACH+TlRoaXMgYXJ0IGlzIGluIHRoZSBwdWJsaWMgZG9tYWluLiBLZXZpbiBIdWdoZXMsIGtldmluaEBlaXQuY29tLCBTZXB0ZW1iZXIgMTk5NQAh+QQBAAACACwAAAAAFAAWAAAEkPDISae4WBzAu99Hdm1eSYYZWXYqOgJBLAcDoNrYNssGsBy/4GsX6y2OyMWQ2OMQngSlBjZLWBM1AFSqkyU4A2tWywUMYt/wlTSIvgYGA/Zq3QwU7mmHvh4g8GUsfAUHCH95NwMHV4SGh4EdihOOjy8rZpSVeiV+mYCWHncKo6Sfm5cliAdQrK1PQBlJsrNSEQA7);\n\t\t\t}\n\n\t\t\t/* text files */\n\t\t\t.txt, .md, .css, .js, .json {\n\t\t\t\tbackground-image: url(data:image/gif;base64,R0lGODlhFAAWAMIAAP///8z//5mZmTMzMwAAAAAAAAAAAAAAACH+TlRoaXMgYXJ0IGlzIGluIHRoZSBwdWJsaWMgZG9tYWluLiBLZXZpbiBIdWdoZXMsIGtldmluaEBlaXQuY29tLCBTZXB0ZW1iZXIgMTk5NQAh+QQBAAABACwAAAAAFAAWAAADWDi6vPEwDECrnSO+aTvPEddVIriN1wVxROtSxBDPJwq7bo23luALhJqt8gtKbrsXBSgcEo2spBLAPDp7UKT02bxWRdrp94rtbpdZMrrr/A5+8LhPFpHajQkAOw==);\n\t\t\t}\n\n\t\t\t/* compressed files */\n\t\t\t.zip, .gz {\n\t\t\t\tbackground-image: url(data:image/gif;base64,R0lGODlhFAAWAOcAAP//////zP//mf//Zv//M///AP/M///MzP/Mmf/MZv/MM//MAP+Z//+ZzP+Zmf+ZZv+ZM/+ZAP9m//9mzP9mmf9mZv9mM/9mAP8z//8zzP8zmf8zZv8zM/8zAP8A//8AzP8Amf8AZv8AM/8AAMz//8z/zMz/mcz/Zsz/M8z/AMzM/8zMzMzMmczMZszMM8zMAMyZ/8yZzMyZmcyZZsyZM8yZAMxm/8xmzMxmmcxmZsxmM8xmAMwz/8wzzMwzmcwzZswzM8wzAMwA/8wAzMwAmcwAZswAM8wAAJn//5n/zJn/mZn/Zpn/M5n/AJnM/5nMzJnMmZnMZpnMM5nMAJmZ/5mZzJmZmZmZZpmZM5mZAJlm/5lmzJlmmZlmZplmM5lmAJkz/5kzzJkzmZkzZpkzM5kzAJkA/5kAzJkAmZkAZpkAM5kAAGb//2b/zGb/mWb/Zmb/M2b/AGbM/2bMzGbMmWbMZmbMM2bMAGaZ/2aZzGaZmWaZZmaZM2aZAGZm/2ZmzGZmmWZmZmZmM2ZmAGYz/2YzzGYzmWYzZmYzM2YzAGYA/2YAzGYAmWYAZmYAM2YAADP//zP/zDP/mTP/ZjP/MzP/ADPM/zPMzDPMmTPMZjPMMzPMADOZ/zOZzDOZmTOZZjOZMzOZADNm/zNmzDNmmTNmZjNmMzNmADMz/zMzzDMzmTMzZjMzMzMzADMA/zMAzDMAmTMAZjMAMzMAAAD//wD/zAD/mQD/ZgD/MwD/AADM/wDMzADMmQDMZgDMMwDMAACZ/wCZzACZmQCZZgCZMwCZAABm/wBmzABmmQBmZgBmMwBmAAAz/wAzzAAzmQAzZgAzMwAzAAAA/wAAzAAAmQAAZgAAM+4AAN0AALsAAKoAAIgAAHcAAFUAAEQAACIAABEAAADuAADdAAC7AACqAACIAAB3AABVAABEAAAiAAARAAAA7gAA3QAAuwAAqgAAiAAAdwAAVQAARAAAIgAAEe7u7t3d3bu7u6qqqoiIiHd3d1VVVURERCIiIhEREQAAACH+TlRoaXMgYXJ0IGlzIGluIHRoZSBwdWJsaWMgZG9tYWluLiBLZXZpbiBIdWdoZXMsIGtldmluaEBlaXQuY29tLCBTZXB0ZW1iZXIgMTk5NQAh+QQBAAAkACwAAAAAFAAWAAAImQBJCCTBqmDBgQgTDmQFAABDVgojEmzI0KHEhBUrWrwoMGNDihwnAvjHiqRJjhX/qVz5D+VHAFZiWmmZ8BGHji9hxqTJ4ZFAmzc1vpxJgkPPn0Y5CP04M6lPEkCN5mxoJelRqFY5TM36NGrPqV67Op0KM6rYnkup/gMq1mdamC1tdn36lijUpwjr0pSoFyUrmTJLhiTBkqXCgAA7)\n\t\t\t}\n\n\t\t\t/* movies */\n\t\t\t.mp4, .mov, .avi {\n\t\t\t\tbackground-image: url(data:image/gif;base64,R0lGODlhFAAWAMIAAP///8z//8zMzJmZmWZmZjMzMwAAAAAAACH+TlRoaXMgYXJ0IGlzIGluIHRoZSBwdWJsaWMgZG9tYWluLiBLZXZpbiBIdWdoZXMsIGtldmluaEBlaXQuY29tLCBTZXB0ZW1iZXIgMTk5NQAh+QQBAAABACwAAAAAFAAWAAADZmi63BrQCOHaNCVewjsHEpUFDDGc6AAuY2iY6Qle7RbLbrvA8arUFF5qJtIEb6pcZAFoOp0MYIVBM748HSJmqRCifFuS7aaVenFV0g4JNrOV4iMZznjao9apIu3SwwMFgYKDhIEQCQA7);\n\t\t\t}\n\n\t\t\t/* audio */\n\t\t\t.wav, .mp3, .aiff, .flac, .ogg {\n\t\t\t\tbackground-image: url(data:image/gif;base64,R0lGODlhFAAWAMIAAP///8z//8zMzJmZmWZmZjMzMwAAAAAAACH+TlRoaXMgYXJ0IGlzIGluIHRoZSBwdWJsaWMgZG9tYWluLiBLZXZpbiBIdWdoZXMsIGtldmluaEBlaXQuY29tLCBTZXB0ZW1iZXIgMTk5NQAh+QQBAAABACwAAAAAFAAWAAADUBi63P7OSPikLXRZQySmGyF6UCgKV8mdm/FFHHqRVVvcNOzdSt7sr4CPMRS6VC8bsmcADIrMT/M5VBo3QYkzh81ufTce0Zph7sqMcBDNXiQAADs=);\n\t\t\t}\n\t\t</style>\n\t</head>\n\n\t<body>\n\t\t<main>\n\t\t\t<h1>{{url}}</h1>\n\t\t\t<ul>\n\t\t\t\t<li class=\'parent\'><a href=\'..\'>parent directory</li>\n\t\t\t\t{{items}}\n\t\t\t</ul>\n\t\t</main>\n\t</body>\n</html>');

function serveDir(filepath, request, response) {
	var index = path.resolve(filepath, 'index.html');

	return sander.exists(index).then(function (exists) {
		if (exists) {
			return serveFile(index, request, response);
		}

		return sander.readdir(filepath).then(function (files) {
			var items = files.map(function (href) {
				var stats = gracefulFs.statSync(path.resolve(filepath, href));
				var isDir = stats.isDirectory();

				return {
					isDir: isDir,
					href: href,
					type: isDir ? 'dir' : path.extname(href)
				};
			});

			items.sort(function (a, b) {
				if (a.isDir && b.isDir || !a.isDir && !b.isDir) {
					return a.href < b.href ? 1 : -1;
				}

				return a.isDir ? -1 : 1;
			});

			var html = dirTemplate({
				url: request.url,
				items: items.map(function (item) {
					return '<li class="' + item.type + '"><a href="' + item.href + '">' + item.href + '</a></li>';
				}).join('')
			});

			response.statusCode = 200;
			response.setHeader('Content-Type', mime.lookup('html'));
			response.setHeader('Content-Length', html.length);

			response.write(html);
			response.end();
		});
	});
}

var charToInteger = {};
var integerToChar = {};

'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/='.split('').forEach(function (char, i) {
	charToInteger[char] = i;
	integerToChar[i] = char;
});

function decode(string) {
	var result = [],
	    len = string.length,
	    i,
	    hasContinuationBit,
	    shift = 0,
	    value = 0,
	    integer,
	    shouldNegate;

	for (i = 0; i < len; i += 1) {
		integer = charToInteger[string[i]];

		if (integer === undefined) {
			throw new Error('Invalid character (' + string[i] + ')');
		}

		hasContinuationBit = integer & 32;

		integer &= 31;
		value += integer << shift;

		if (hasContinuationBit) {
			shift += 5;
		} else {
			shouldNegate = value & 1;
			value >>= 1;

			result.push(shouldNegate ? -value : value);

			// reset
			value = shift = 0;
		}
	}

	return result;
}

function encode(value) {
	var result, i;

	if (typeof value === 'number') {
		result = encodeInteger(value);
	} else {
		result = '';
		for (i = 0; i < value.length; i += 1) {
			result += encodeInteger(value[i]);
		}
	}

	return result;
}

function encodeInteger(num) {
	var result = '',
	    clamped;

	if (num < 0) {
		num = -num << 1 | 1;
	} else {
		num <<= 1;
	}

	do {
		clamped = num & 31;
		num >>= 5;

		if (num > 0) {
			clamped |= 32;
		}

		result += integerToChar[clamped];
	} while (num > 0);

	return result;
}

var cache = {};

function decodeSegments(encodedSegments) {
	var i = encodedSegments.length;
	var segments = new Array(i);

	while (i--) {
		segments[i] = decode(encodedSegments[i]);
	}

	return segments;
}
function decodeMappings(mappings) {
	var checksum = crc32(mappings);

	if (!cache[checksum]) {
		var sourceFileIndex = 0; // second field
		var sourceCodeLine = 0; // third field
		var sourceCodeColumn = 0; // fourth field
		var nameIndex = 0; // fifth field

		var lines = mappings.split(';');
		var numLines = lines.length;
		var decoded = new Array(numLines);

		var i = undefined,
		    j = undefined,
		    line = undefined,
		    generatedCodeColumn = undefined,
		    decodedLine = undefined,
		    segments = undefined,
		    segment = undefined,
		    result = undefined;

		for (i = 0; i < numLines; i += 1) {
			line = lines[i];

			generatedCodeColumn = 0; // first field - reset each time
			decodedLine = [];

			segments = decodeSegments(line.split(','));

			for (j = 0; j < segments.length; j += 1) {
				segment = segments[j];

				if (!segment.length) {
					break;
				}

				generatedCodeColumn += segment[0];

				result = [generatedCodeColumn];
				decodedLine.push(result);

				if (segment.length === 1) {
					// only one field!
					break;
				}

				sourceFileIndex += segment[1];
				sourceCodeLine += segment[2];
				sourceCodeColumn += segment[3];

				result.push(sourceFileIndex, sourceCodeLine, sourceCodeColumn);

				if (segment.length === 5) {
					nameIndex += segment[4];
					result.push(nameIndex);
				}
			}

			decoded[i] = decodedLine;
		}

		cache[checksum] = decoded;
	}

	return cache[checksum];
}

function atob$1(base64) {
  return new Buffer(base64, 'base64').toString('utf8');
}

/**
 * Turns a sourceMappingURL into a sourcemap
 * @param {string} url - the URL (i.e. sourceMappingURL=url). Can
   be a base64-encoded data URI
 * @param {string} base - the URL against which relative URLS
   should be resolved
 * @param {boolean} sync - if `true`, return a promise, otherwise
   return the sourcemap
 * @returns {object} - a version 3 sourcemap
 */
function getMapFromUrl(url, base, sync) {
	if (/^data:/.test(url)) {
		// TODO beef this up
		var match = /base64,(.+)$/.exec(url);

		if (!match) {
			throw new Error('sourceMappingURL is not base64-encoded');
		}

		var json = atob$1(match[1]);
		var map = JSON.parse(json);
		return sync ? map : sander.Promise.resolve(map);
	}

	url = path.resolve(path.dirname(base), decodeURI(url));

	if (sync) {
		return JSON.parse(sander.readFileSync(url).toString());
	} else {
		return sander.readFile(url).then(String).then(JSON.parse);
	}
}

function getSourceMappingUrl(str) {
	var index, substring, url, match;

	// assume we want the last occurence
	index = str.lastIndexOf('sourceMappingURL=');

	if (index === -1) {
		return null;
	}

	substring = str.substring(index + 17);
	match = /^[^\r\n]+/.exec(substring);

	url = match ? match[0] : null;

	// possibly a better way to do this, but we don't want to exclude whitespace
	// from the sourceMappingURL because it might not have been correctly encoded
	if (url && url.slice(-2) === '*/') {
		url = url.slice(0, -2).trim();
	}

	return url;
}

function getMap(node, sourceMapByPath, sync) {
	if (node.file in sourceMapByPath) {
		var map = sourceMapByPath[node.file];
		return sync ? map : sander.Promise.resolve(map);
	} else {
		var url = getSourceMappingUrl(node.content);

		if (!url) {
			node.isOriginalSource = true;
			return sync ? null : sander.Promise.resolve(null);
		}

		return getMapFromUrl(url, node.file, sync);
	}
}

var Node$1 = (function () {
	function Node(_ref) {
		var file = _ref.file;
		var content = _ref.content;
		babelHelpers_classCallCheck(this, Node);

		this.file = file ? path.resolve(file) : null;
		this.content = content || null; // sometimes exists in sourcesContent, sometimes doesn't

		if (!this.file && this.content === null) {
			throw new Error('A source must specify either file or content');
		}

		// these get filled in later
		this.map = null;
		this.mappings = null;
		this.sources = null;
		this.isOriginalSource = null;

		this._stats = {
			decodingTime: 0,
			encodingTime: 0,
			tracingTime: 0,

			untraceable: 0
		};
	}

	Node.prototype.load = function load(sourcesContentByPath, sourceMapByPath) {
		var _this = this;

		return getContent(this, sourcesContentByPath).then(function (content) {
			_this.content = sourcesContentByPath[_this.file] = content;

			return getMap(_this, sourceMapByPath).then(function (map) {
				if (!map) return null;

				_this.map = map;

				var decodingStart = process.hrtime();
				_this.mappings = decodeMappings(map.mappings);
				var decodingTime = process.hrtime(decodingStart);
				_this._stats.decodingTime = 1e9 * decodingTime[0] + decodingTime[1];

				var sourcesContent = map.sourcesContent || [];

				_this.sources = map.sources.map(function (source, i) {
					return new Node({
						file: source ? resolveSourcePath(_this, map.sourceRoot, source) : null,
						content: sourcesContent[i]
					});
				});

				var promises = _this.sources.map(function (node) {
					return node.load(sourcesContentByPath, sourceMapByPath);
				});
				return sander.Promise.all(promises);
			});
		});
	};

	Node.prototype.loadSync = function loadSync(sourcesContentByPath, sourceMapByPath) {
		var _this2 = this;

		if (!this.content) {
			if (!sourcesContentByPath[this.file]) {
				sourcesContentByPath[this.file] = sander.readFileSync(this.file).toString();
			}

			this.content = sourcesContentByPath[this.file];
		}

		var map = getMap(this, sourceMapByPath, true);
		var sourcesContent = undefined;

		if (!map) {
			this.isOriginalSource = true;
		} else {
			this.map = map;
			this.mappings = decodeMappings(map.mappings);

			sourcesContent = map.sourcesContent || [];

			this.sources = map.sources.map(function (source, i) {
				var node = new Node({
					file: resolveSourcePath(_this2, map.sourceRoot, source),
					content: sourcesContent[i]
				});

				node.loadSync(sourcesContentByPath, sourceMapByPath);
				return node;
			});
		}
	};

	/**
  * Traces a segment back to its origin
  * @param {number} lineIndex - the zero-based line index of the
    segment as found in `this`
  * @param {number} columnIndex - the zero-based column index of the
    segment as found in `this`
  * @param {string || null} - if specified, the name that should be
    (eventually) returned, as it is closest to the generated code
  * @returns {object}
      @property {string} source - the filepath of the source
      @property {number} line - the one-based line index
      @property {number} column - the zero-based column index
      @property {string || null} name - the name corresponding
      to the segment being traced
  */

	Node.prototype.trace = function trace(lineIndex, columnIndex, name) {
		// If this node doesn't have a source map, we have
		// to assume it is the original source
		if (this.isOriginalSource) {
			return {
				source: this.file,
				line: lineIndex + 1,
				column: columnIndex || 0,
				name: name
			};
		}

		// Otherwise, we need to figure out what this position in
		// the intermediate file corresponds to in *its* source
		var segments = this.mappings[lineIndex];

		if (!segments || segments.length === 0) {
			return null;
		}

		if (columnIndex != null) {
			var len = segments.length;
			var i = undefined;

			for (i = 0; i < len; i += 1) {
				var generatedCodeColumn = segments[i][0];

				if (generatedCodeColumn > columnIndex) {
					break;
				}

				if (generatedCodeColumn === columnIndex) {
					if (segments[i].length < 4) return null;

					var _sourceFileIndex = segments[i][1];
					var _sourceCodeLine = segments[i][2];
					var sourceCodeColumn = segments[i][3];
					var _nameIndex = segments[i][4];

					var _parent = this.sources[_sourceFileIndex];
					return _parent.trace(_sourceCodeLine, sourceCodeColumn, this.map.names[_nameIndex] || name);
				}
			}
		}

		// fall back to a line mapping
		var sourceFileIndex = segments[0][1];
		var sourceCodeLine = segments[0][2];
		var nameIndex = segments[0][4];

		var parent = this.sources[sourceFileIndex];
		return parent.trace(sourceCodeLine, null, this.map.names[nameIndex] || name);
	};

	return Node;
})();

function getContent(node, sourcesContentByPath) {
	if (node.file in sourcesContentByPath) {
		node.content = sourcesContentByPath[node.file];
	}

	if (!node.content) {
		return sander.readFile(node.file).then(String);
	}

	return sander.Promise.resolve(node.content);
}

function resolveSourcePath(node, sourceRoot, source) {
	return path.resolve(path.dirname(node.file), sourceRoot || '', source);
}

function btoa(str) {
  return new Buffer(str).toString('base64');
}

var SourceMap = (function () {
	function SourceMap(properties) {
		babelHelpers_classCallCheck(this, SourceMap);

		this.version = 3;

		this.file = properties.file;
		this.sources = properties.sources;
		this.sourcesContent = properties.sourcesContent;
		this.names = properties.names;
		this.mappings = properties.mappings;
	}

	SourceMap.prototype.toString = function toString() {
		return JSON.stringify(this);
	};

	SourceMap.prototype.toUrl = function toUrl() {
		return 'data:application/json;charset=utf-8;base64,' + btoa(this.toString());
	};

	return SourceMap;
})();

function encodeMappings(decoded) {
	var offsets = {
		generatedCodeColumn: 0,
		sourceFileIndex: 0, // second field
		sourceCodeLine: 0, // third field
		sourceCodeColumn: 0, // fourth field
		nameIndex: 0 // fifth field
	};

	return decoded.map(function (line) {
		offsets.generatedCodeColumn = 0; // first field - reset each time
		return line.map(encodeSegment).join(',');
	}).join(';');

	function encodeSegment(segment) {
		if (!segment.length) {
			return segment;
		}

		var result = new Array(segment.length);

		result[0] = segment[0] - offsets.generatedCodeColumn;
		offsets.generatedCodeColumn = segment[0];

		if (segment.length === 1) {
			// only one field!
			return result;
		}

		result[1] = segment[1] - offsets.sourceFileIndex;
		result[2] = segment[2] - offsets.sourceCodeLine;
		result[3] = segment[3] - offsets.sourceCodeColumn;

		offsets.sourceFileIndex = segment[1];
		offsets.sourceCodeLine = segment[2];
		offsets.sourceCodeColumn = segment[3];

		if (segment.length === 5) {
			result[4] = segment[4] - offsets.nameIndex;
			offsets.nameIndex = segment[4];
		}

		return encode(result);
	}
}

function slash(path) {
  if (typeof path === 'string') return path.replace(/\\/g, '/');
  return path;
}

var SOURCEMAPPING_URL$1 = 'sourceMa';
SOURCEMAPPING_URL$1 += 'ppingURL';

var SOURCEMAP_COMMENT$1 = new RegExp('\n*(?:' + ('\\/\\/[@#]\\s*' + SOURCEMAPPING_URL$1 + '=([^\'"]+)|') + ( // js
'\\/\\*#?\\s*' + SOURCEMAPPING_URL$1 + '=([^\'"]+)\\s\\*\\/)') + // css
'\\s*$', 'g');

var Chain = (function () {
	function Chain(node, sourcesContentByPath) {
		babelHelpers_classCallCheck(this, Chain);

		this.node = node;
		this.sourcesContentByPath = sourcesContentByPath;

		this._stats = {};
	}

	Chain.prototype.stat = function stat() {
		return {
			selfDecodingTime: this._stats.decodingTime / 1e6,
			totalDecodingTime: (this._stats.decodingTime + tally(this.node.sources, 'decodingTime')) / 1e6,

			encodingTime: this._stats.encodingTime / 1e6,
			tracingTime: this._stats.tracingTime / 1e6,

			untraceable: this._stats.untraceable
		};
	};

	Chain.prototype.apply = function apply() {
		var _this = this;

		var options = arguments.length <= 0 || arguments[0] === undefined ? {} : arguments[0];

		var allNames = [];
		var allSources = [];

		var applySegment = function applySegment(segment, result) {
			if (segment.length < 4) return;

			var traced = _this.node.sources[segment[1]].trace( // source
			segment[2], // source code line
			segment[3], // source code column
			_this.node.map.names[segment[4]]);

			if (!traced) {
				_this._stats.untraceable += 1;
				return;
			}

			var sourceIndex = allSources.indexOf(traced.source);
			if (! ~sourceIndex) {
				sourceIndex = allSources.length;
				allSources.push(traced.source);
			}

			var newSegment = [segment[0], // generated code column
			sourceIndex, traced.line - 1, traced.column];

			if (traced.name) {
				var nameIndex = allNames.indexOf(traced.name);
				if (! ~nameIndex) {
					nameIndex = allNames.length;
					allNames.push(traced.name);
				}

				newSegment[4] = nameIndex;
			}

			result[result.length] = newSegment;
		};

		// Trace mappings
		var tracingStart = process.hrtime();

		var i = this.node.mappings.length;
		var resolved = new Array(i);

		var j = undefined,
		    line = undefined,
		    result = undefined;

		while (i--) {
			line = this.node.mappings[i];
			resolved[i] = result = [];

			for (j = 0; j < line.length; j += 1) {
				applySegment(line[j], result);
			}
		}

		var tracingTime = process.hrtime(tracingStart);
		this._stats.tracingTime = 1e9 * tracingTime[0] + tracingTime[1];

		// Encode mappings
		var encodingStart = process.hrtime();
		var mappings = encodeMappings(resolved);
		var encodingTime = process.hrtime(encodingStart);
		this._stats.encodingTime = 1e9 * encodingTime[0] + encodingTime[1];

		var includeContent = options.includeContent !== false;

		return new SourceMap({
			file: path.basename(this.node.file),
			sources: allSources.map(function (source) {
				return slash(path.relative(options.base || path.dirname(_this.node.file), source));
			}),
			sourcesContent: allSources.map(function (source) {
				return includeContent ? _this.sourcesContentByPath[source] : null;
			}),
			names: allNames,
			mappings: mappings
		});
	};

	Chain.prototype.trace = function trace(oneBasedLineIndex, zeroBasedColumnIndex) {
		return this.node.trace(oneBasedLineIndex - 1, zeroBasedColumnIndex, null);
	};

	Chain.prototype.write = function write(dest, options) {
		if (typeof dest !== 'string') {
			options = dest;
			dest = this.node.file;
		}

		options = options || {};

		var _processWriteOptions = processWriteOptions(dest, this, options);

		var resolved = _processWriteOptions.resolved;
		var content = _processWriteOptions.content;
		var map = _processWriteOptions.map;

		var promises = [sander.writeFile(resolved, content)];

		if (!options.inline) {
			promises.push(sander.writeFile(resolved + '.map', map.toString()));
		}

		return Promise.all(promises);
	};

	Chain.prototype.writeSync = function writeSync(dest, options) {
		if (typeof dest !== 'string') {
			options = dest;
			dest = this.node.file;
		}

		options = options || {};

		var _processWriteOptions2 = processWriteOptions(dest, this, options);

		var resolved = _processWriteOptions2.resolved;
		var content = _processWriteOptions2.content;
		var map = _processWriteOptions2.map;

		sander.writeFileSync(resolved, content);

		if (!options.inline) {
			sander.writeFileSync(resolved + '.map', map.toString());
		}
	};

	return Chain;
})();

function processWriteOptions(dest, chain, options) {
	var resolved = path.resolve(dest);

	var map = chain.apply({
		includeContent: options.includeContent,
		base: options.base ? path.resolve(options.base) : path.dirname(resolved)
	});

	var url = options.inline ? map.toUrl() : (options.absolutePath ? resolved : path.basename(resolved)) + '.map';

	// TODO shouldn't url be relative?
	var content = chain.node.content.replace(SOURCEMAP_COMMENT$1, '') + sourcemapComment(url, resolved);

	return { resolved: resolved, content: content, map: map };
}

function tally(nodes, stat) {
	return nodes.reduce(function (total, node) {
		return total + node._stats[stat];
	}, 0);
}

function sourcemapComment(url, dest) {
	var ext = path.extname(dest);
	url = encodeURI(url);

	if (ext === '.css') {
		return '\n/*# ' + SOURCEMAPPING_URL$1 + '=' + url + ' */\n';
	}

	return '\n//# ' + SOURCEMAPPING_URL$1 + '=' + url + '\n';
}

function load(file, options) {
	var _init = init(file, options);

	var node = _init.node;
	var sourcesContentByPath = _init.sourcesContentByPath;
	var sourceMapByPath = _init.sourceMapByPath;

	return node.load(sourcesContentByPath, sourceMapByPath).then(function () {
		return node.isOriginalSource ? null : new Chain(node, sourcesContentByPath);
	});
}

function init(file) {
	var options = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

	var node = new Node$1({ file: file });

	var sourcesContentByPath = {};
	var sourceMapByPath = {};

	if (options.content) {
		Object.keys(options.content).forEach(function (key) {
			sourcesContentByPath[path.resolve(key)] = options.content[key];
		});
	}

	if (options.sourcemaps) {
		Object.keys(options.sourcemaps).forEach(function (key) {
			sourceMapByPath[path.resolve(key)] = options.sourcemaps[key];
		});
	}

	return { node: node, sourcesContentByPath: sourcesContentByPath, sourceMapByPath: sourceMapByPath };
}

function serveSourcemap(filepath, sourcemapPromises, request, response) {
	var owner = filepath.slice(0, -4);

	if (!sourcemapPromises[filepath]) {
		sourcemapPromises[filepath] = load(owner).then(function (chain) {
			if (!chain) {
				throw new Error('Could not resolve sourcemap for ' + owner);
			}

			return chain.apply().toString();
		});
	}

	return sourcemapPromises[filepath].then(function (map) {
		response.statusCode = 200;
		response.setHeader('Content-Type', 'application/json');

		response.write(map);
		response.end();
	});
}

var errTemplate = compile('<!doctype html>\n<html>\n<head>\n\t<meta charset=\'utf-8\'>\n\t<meta name=\'viewport\' content=\'width=device-width, user-scalable=no\'>\n\n\t<title>gobble error</title>\n\n\t<style>\n\t\tbody {\n\t\t\ttext-align: center;\n\t\t\tfont-family: \'Helvetica Neue\', arial, sans-serif;\n\t\t\tcolor: #666;\n\t\t\tfont-weight: 200;\n\t\t\tline-height: 1.4;\n\t\t\tpadding: 0 1em;\n\t\t\tmax-width: 72em;\n\t\t\tmargin: 0 auto;\n\t\t}\n\n\t\th1 {\n\t\t\tcolor: rgb(150,0,0);\n\t\t\tfont-weight: 100;\n\t\t\tfont-size: 6em;\n\t\t\tmargin: 0;\n\t\t}\n\n\t\tp {\n\t\t\tmargin: 0 0 1em 0;\n\t\t}\n\n\t\t.error-message, .stack {\n\t\t\tpadding: 2em 4em;\n\t\t\tfont-family: \'Inconsolata\', \'Source Code Pro\', \'Consolas\', \'Monaco\', monospace;\n\t\t\ttext-align: left;\n\t\t}\n\n\t\t.error-message a, .stack a {\n\t\t\tcolor: inherit;\n\t\t\tword-break: break-all;\n\t\t}\n\n\t\t.error-message {\n\t\t\tbackground-color: #333;\n\t\t\tcolor: white;\n\t\t\tmargin: 0;\n\t\t}\n\n\t\t.error-message span {\n\t\t\tword-break: break-all;\n\t\t}\n\n\t\t.stack {\n\t\t\tmargin: 0;\n\t\t\tpadding: 2em 4em;\n\t\t\tbackground-color: #555;\n\t\t\tcolor: white;\n\t\t}\n\t</style>\n</head>\n\n<body>\n\t<h1>Oops!</h1>\n\n\t<p>Something appears to have gone wrong with the <strong>{{id}}</strong> node:</p>\n\n\t<p class=\'error-message\'>{{message}}</p>\n\n\t<ul class=\'stack\'>{{stack}}</ul>\n</body>\n</html>');

var waitingTemplate = compile('<!doctype html>\n<html>\n<head>\n\t<meta charset=\'utf-8\'>\n\t<meta name=\'viewport\' content=\'width=device-width, user-scalable=no\'>\n\n\t<title>gobbling...</title>\n\n\t<style>\n\t\tbody {\n\t\t\ttext-align: center;\n\t\t\tfont-family: \'Helvetica Neue\', arial, sans-serif;\n\t\t\tcolor: #666;\n\t\t\tfont-weight: 200;\n\t\t\tline-height: 1.4;\n\t\t}\n\n\t\th1 {\n\t\t\tfont-weight: 100;\n\t\t\tfont-size: 6em;\n\t\t\tmargin: 0;\n\t\t}\n\n\t\tp {\n\t\t\tmax-width: 30em;\n\t\t\tmargin: 0 auto 1em auto;\n\t\t}\n\n\t\timg {\n\t\t\twidth: 100%;\n\t\t\tmax-width: 20em;\n\t\t\tmargin: 0 auto 1em auto;\n\t\t}\n\t</style>\n</head>\n\n<body>\n\t<h1>gobbling...</h1>\n\t<p>gobble is building the project. please wait...</p>\n\t<img src=\'data:image/svg+xml;base64,PD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0idXRmLTgiPz4NCjwhLS0gR2VuZXJhdG9yOiBBZG9iZSBJbGx1c3RyYXRvciAxOC4wLjAsIFNWRyBFeHBvcnQgUGx1Zy1JbiAuIFNWRyBWZXJzaW9uOiA2LjAwIEJ1aWxkIDApICAtLT4NCjwhRE9DVFlQRSBzdmcgUFVCTElDICItLy9XM0MvL0RURCBTVkcgMS4xLy9FTiIgImh0dHA6Ly93d3cudzMub3JnL0dyYXBoaWNzL1NWRy8xLjEvRFREL3N2ZzExLmR0ZCI+DQo8c3ZnIHZlcnNpb249IjEuMSIgaWQ9IkxheWVyXzEiIHhtbG5zPSJodHRwOi8vd3d3LnczLm9yZy8yMDAwL3N2ZyIgeG1sbnM6eGxpbms9Imh0dHA6Ly93d3cudzMub3JnLzE5OTkveGxpbmsiIHg9IjBweCIgeT0iMHB4Ig0KCSB2aWV3Qm94PSIwIDAgNDAwIDQwMCIgZW5hYmxlLWJhY2tncm91bmQ9Im5ldyAwIDAgNDAwIDQwMCIgeG1sOnNwYWNlPSJwcmVzZXJ2ZSI+DQo8cGF0aCBmaWxsPSIjQUQ0RTI2IiBkPSJNMzIyLDIxNS45Yy03LjUsMy42LTEyLjYsOS43LTE3LDE2LjRjLTUuNSw4LjUtMTAuNywxNy4yLTE2LjEsMjUuOGMtNy4xLDExLjMtMTQuNSwyMi4zLTI0LjEsMzEuNg0KCWMtMTMuOCwxMy41LTMwLjEsMjIuNy00OC4zLDI4LjdjLTEuNiwwLjUtMy4xLDEuMS00LjcsMS42Yy0xLjIsMS4yLTIuNywxLjQtNC4zLDAuOWMtMy44LDAuMy03LjYsMC44LTExLjQsMQ0KCWMtOS41LDAuNS0xOC44LTEuMy0yOC0zLjhjLTEuNywwLjgtMywwLTQuMi0xLjFjLTEuNS0wLjgtMi45LTEuNi00LjQtMi4zYy0zMS4yLTE0LjgtNDkuMi0zOS45LTU2LjQtNzMuMQ0KCWMtMS42LTcuNi0yLjMtMTUuNC0yLjktMjMuMmMtMC44LTEwLjMtMi41LTIwLjQtNS0zMC4zYzguMi0xMC42LDE5LjQtMTcuNCwzMC43LTI0LjFjMTMuNy0zLjksMjcuOS01LjMsNDEuOC04LjINCgljMTMuOS0wLjYsMjcuNy0wLjQsNDEuNSwwLjljMTEuNiwxLjEsMjIuOSwzLjUsMzMuNyw3LjhjMi42LDEsNS41LDEuNSw3LjQsMy44Yy0xLDcuMi0yLjEsMTQuNC0zLDIxLjdjLTAuOSw2LjgtMC43LDEzLjYsMC45LDIwLjMNCgljMC40LDEuNywxLjMsMy40LDIuMiw1YzEuOCwzLjIsNC43LDQuOCw4LjMsNC4xYzIuNC0wLjQsNC45LTEsNy0yLjJjNi4zLTMuNywxMS45LTguMSwxNS42LTE0LjljNi4zLTExLjUsMTUuNC0yMC40LDI3LjctMjUuNA0KCWMxMC00LjEsMTkuNy0zLjksMjguOCwyLjZjMC44LDAuOCwxLDEuOCwwLjgsMi43Yy0xLjIsNS4yLDAuMyw5LjgsMy4yLDE0LjFjLTIuMywzLjMtNC42LDYuNi03LDkuOQ0KCUMzMzEuMiwyMDkuOSwzMjYuNywyMTMuMiwzMjIsMjE1Ljl6Ii8+DQo8cGF0aCBmaWxsPSIjRUQ2NTI1IiBkPSJNMjEwLDE1OGMtMTQuMy0wLjMtMjguNy0wLjctNDMtMWMtMC44LTEtMS0yLTAuMS0zLjFjMi0xNi42LDQtMzMuMyw1LjktNDkuOWMwLjYtNS4xLDEtMTAuMywxLjItMTUuNA0KCWMwLjUtMTYuOCwyLTMzLjUsNC4yLTUwLjFjMS03LjEsNC0xMy4yLDktMTguNWM2LjEtNi4zLDE3LjYtNS41LDIyLjYsMy4xYzIuNyw0LjUsNC4xLDkuNSw0LjEsMTQuN2MwLDkuMy0wLjUsMTguNi0wLjgsMjcuOQ0KCWMtMC40LDExLjMtMSwyMi42LTEuMywzMy45Yy0wLjQsMTYuMy0wLjcsMzIuNi0xLDQ4LjlDMjEwLjksMTQ5LjksMjEwLjksMTU2LjUsMjEwLDE1OHoiLz4NCjxwYXRoIGZpbGw9IiNGRUJGMTUiIGQ9Ik0xNjYuOCwxNTMuOGMwLDEsMC4xLDIuMSwwLjEsMy4xYy00LjMsMS04LjYsMi4xLTEyLjksMi45Yy04LjQsMS42LTE2LjgsMy4yLTI1LjIsNC43DQoJYy0xLjMsMC4yLTIuNiwwLjMtMy45LDAuNWMtMC43LTAuNS0xLjYtMC45LTAuNi0yYzAuMi0xLjMsMC42LTIuNiwwLjUtMy44Yy0wLjktMTQuMi0xLjctMjguNS0zLTQyLjdjLTAuOS05LjktMi41LTE5LjctMy41LTI5LjYNCgljLTEtMTAuMS0yLjItMjAuMi0wLjQtMzAuM2MxLjItNi4zLDMuNy0xMS43LDEwLjEtMTQuNGM2LjItMi42LDExLjctMS41LDE1LjMsNC4xYzIuNyw0LjEsNS4xLDguNyw2LjQsMTMuM2MyLjIsOCwzLjcsMTYuMSw1LDI0LjMNCgljMi43LDE2LDUsMzIuMSw3LjYsNDguMWMxLjEsNi43LDIuNCwxMy40LDMuNiwyMEMxNjYuMiwxNTIuOCwxNjYuNiwxNTMuMywxNjYuOCwxNTMuOHoiLz4NCjxwYXRoIGZpbGw9IiNCRjI0MjYiIGQ9Ik0yMTAsMTU4YzAuNi0xLjcsMS4yLTMuNCwxLjktNWMyLTguOSw0LjMtMTcuOCw2LjEtMjYuN2MzLjEtMTUsNi0zMCw5LTQ0LjljMS41LTcuNCw0LjItMTQuNCw4LTIwLjgNCgljMS43LTIuOCwzLjYtNS42LDYtNy45YzcuNy03LjYsMTguOS01LjQsMjMuMyw0LjZjMSwyLjQsMS41LDUuMSwxLjcsNy43YzAuOSwxMC40LTEuMywyMC41LTMuMSwzMC43Yy0zLjEsMTcuNS02LDM1LTksNTIuNg0KCWMtMS4xLDYuNy0yLjQsMTMuMy0zLjYsMjBjLTQuOC0xLjYtOS42LTMuMi0xNC41LTQuN2MtNy0yLjMtMTQtNC42LTIxLjYtNC41QzIxMi44LDE1OC45LDIxMS40LDE1OC4zLDIxMCwxNTh6Ii8+DQo8cGF0aCBmaWxsPSIjNTczNzE1IiBkPSJNMTI0LjMsMTYzLjFjMC4yLDAuNywwLjQsMS4zLDAuNiwyYy0zLjQsMi41LTYuNiw1LjMtMTAuMiw3LjRjLTUuNywzLjQtMTAuNyw3LjYtMTUuMywxMi40DQoJYy0xLjIsMS4zLTIuOCwyLjEtNC4yLDMuMmMtNy42LTIxLjktMTUuMy00My43LTIyLjgtNjUuN2MtMS44LTUuMy0zLjEtMTAuOC00LjMtMTYuM0M2NS44LDk1LjQsNzYsODYuMSw4Ni40LDg5LjMNCgljMy4yLDEsNS41LDMuMSw2LjksNmM0LjMsOC42LDguNiwxNy4yLDEyLjYsMjUuOUMxMTIuMiwxMzUuMSwxMTguMiwxNDkuMSwxMjQuMywxNjMuMXoiLz4NCjxwYXRoIGZpbGw9IiM2MjQxMUUiIGQ9Ik0yMDcuNSwzMjAuOGMxLjQtMC4zLDIuOS0wLjYsNC4zLTAuOWMwLjQsMTAuNiwwLjgsMjEuMiwxLjEsMzEuOWMwLjEsMiwwLjcsMy40LDEuOCw1DQoJYzMsNC4yLDUuNyw4LjUsOC41LDEyLjhjMC41LDAuOCwxLjEsMS44LDEuMiwyLjdjMCwwLjgtMC41LDEuOS0xLjEsMi40Yy0wLjMsMC4zLTEuNy0wLjEtMi4yLTAuNmMtMC44LTAuOC0xLjMtMS45LTEuOS0yLjkNCgljLTEuOS0zLjEtMy43LTYuMi02LjUtOWMtMC4zLDIuNC0wLjUsNC44LTAuOCw3LjJjLTAuNCwzLjEtMC44LDYuMy0xLjIsOS40Yy0wLjIsMS42LTAuOSwzLjMtMi43LDNjLTIuMS0wLjMtMS45LTIuMi0xLjYtNA0KCWMwLjgtNS4xLDEuMy0xMC4yLDEuOS0xNS4yYy0wLjMtMC4yLTAuNi0wLjMtMC45LTAuNWMtMi44LDIuOC01LjYsNS43LTguNCw4LjVjLTAuOCwwLjgtMS41LDEuOS0yLjUsMi40Yy0wLjcsMC4zLTIuMiwwLjItMi42LTAuMw0KCWMtMC41LTAuNS0wLjUtMS45LTAuMS0yLjZjMC41LTEsMS42LTEuNywyLjQtMi41YzMuMi0zLjQsNi40LTYuOCw5LjYtMTAuMWMxLjktMiwyLjgtNC40LDIuNy03LjINCglDMjA4LjIsMzQwLjQsMjA3LjgsMzMwLjYsMjA3LjUsMzIwLjh6Ii8+DQo8cGF0aCBmaWxsPSIjNjI0MTFFIiBkPSJNMTYzLjksMzE3YzEuNCwwLjQsMi44LDAuNyw0LjIsMS4xYzAuMSw0LjYsMC4zLDkuMywwLjMsMTMuOWMwLDYuMiwwLDEyLjMtMC40LDE4LjRjLTAuMiwzLjQsMC45LDYsMi44LDguNw0KCWMyLjUsMy41LDQuNSw3LjMsNi43LDExLjFjMC40LDAuNywwLjcsMS41LDEuMSwyLjNjMC43LDEuNCwwLjUsMi44LTEsMy4zYy0wLjcsMC4yLTIuMS0wLjctMi42LTEuNGMtMS0xLjMtMS40LTMtMi4zLTQuNA0KCWMtMS40LTIuNC0yLjktNC43LTUtOC4xYy0xLDYuMi0xLjgsMTEuMy0yLjcsMTYuNGMtMC4zLDEuNC0wLjgsMi45LTEuNSw0LjFjLTAuMiwwLjMtMi4yLDAuMS0yLjMtMC4yYy0wLjQtMS4yLTAuNi0yLjUtMC40LTMuOA0KCWMwLjgtNS4yLDEuNy0xMC40LDEuOC0xNmMtMy4zLDMuMS02LjYsNi4zLTEwLDkuNGMtMS4yLDEuMS0yLjUsMy00LjEsMS4yYy0xLjQtMS41LDAtMywxLjItNC4yYzMuNy0zLjYsNy4zLTcuMiwxMS4xLTEwLjgNCgljMi4zLTIuMiwzLjQtNC43LDMuMy04QzE2My44LDMzOSwxNjMuOSwzMjgsMTYzLjksMzE3eiIvPg0KPHBhdGggZmlsbD0iI0MwMkMyOSIgZD0iTTMyMiwyMTUuOWMzLjYtNC40LDguMS03LjUsMTMtMTBjMi44LDIuMywzLjIsNS4zLDIuNiw4LjZjLTAuOCw0LjctMS44LDkuNC0yLjcsMTQuMQ0KCWMtMC4yLDEuMS0wLjYsMi4zLTEuMiwzLjNjLTEsMS44LTIuMywzLjMtNC44LDIuN2MtMy0wLjctNC41LTIuMy00LjYtNWMtMC4xLTEtMC4xLTIsMC4yLTNDMzI1LjYsMjIyLjYsMzI0LjUsMjE5LjEsMzIyLDIxNS45eiIvPg0KPHBhdGggZmlsbD0iI0ZFQkYxNSIgZD0iTTM0MS45LDE5NmMtNC41LTEuMy00LjMtNS4zLTQuOC04LjZjLTAuNC0yLjYsMC41LTUuNSwwLjgtOC4yYzMuMSwwLjMsNi4yLDAuNSw5LjMsMC45DQoJYzMuOCwwLjQsNy41LDEsMTIuMywxLjZDMzUzLjMsMTg2LjgsMzQ3LjYsMTkxLjQsMzQxLjksMTk2eiIvPg0KPHBhdGggZmlsbD0iIzU2MzUxMiIgZD0iTTE2OCwyMzUuM2MtNy44LDAuOC0xNS4xLDEuNS0yMi40LDIuMmMtMC4xLTAuNC0wLjMtMC44LTAuNC0xLjJjMS42LTEsMy4yLTEuOSw0LjgtMi45DQoJYzExLjUtNy4xLDIyLjgtMTQuNywzNC42LTIxLjNjMTAuMS01LjYsMjAuOC02LjMsMzAuOSwwLjdjMTMsOC45LDE0LjUsMjcsMC45LDM4Yy05LjIsNy40LTE5LjksMTEuNy0zMSwxNC44DQoJYy05LjYsMi43LTE5LjUsNC4zLTI5LjMsNi4zYy0wLjgsMC4yLTEuNiwwLTMuNiwwYzQuNy0zLjYsOC43LTYuNCwxMi40LTkuNGMzLjgtMy4xLDcuNS02LjUsMTEtMTAuMWMtMTEuNywyLjEtMjMuMSw1LjktMzUuOCw0LjMNCglDMTQ5LjQsMjQ5LjQsMTU5LjIsMjQzLjMsMTY4LDIzNS4zeiIvPg0KPHBhdGggZmlsbD0iIzE3MEEwMiIgZD0iTTMxOS4zLDE5NmMtMy40LTAuMS01LjQtMi4zLTUuMy01LjdjMC4xLTIuOCwyLjgtNS40LDUuNC01LjNjMywwLjIsNS42LDMsNS41LDUuOQ0KCUMzMjQuOCwxOTMuNiwzMjIuMSwxOTYsMzE5LjMsMTk2eiIvPg0KPC9zdmc+DQo=\'>\n\t<script>\n\t\tsetTimeout( function () {\n\t\t\tlocation.reload();\n\t\t}, 1000 );\n\t</script>\n</body>\n</html>');

var notfoundTemplate = compile('<!doctype html>\n<html>\n<head>\n\t<meta charset=\'utf-8\'>\n\t<meta name=\'viewport\' content=\'width=device-width, user-scalable=no\'>\n\n\t<title>file not found</title>\n\n\t<style>\n\t\tbody {\n\t\t\ttext-align: center;\n\t\t\tfont-family: \'Helvetica Neue\', arial, sans-serif;\n\t\t\tcolor: #666;\n\t\t\tfont-weight: 200;\n\t\t\tline-height: 1.4;\n\t\t}\n\n\t\th1 {\n\t\t\tcolor: rgb(150,0,0);\n\t\t\tfont-weight: 100;\n\t\t\tfont-size: 6em;\n\t\t\tmargin: 0;\n\t\t}\n\n\t\tp {\n\t\t\tmax-width: 30em;\n\t\t\tmargin: 0 auto 1em auto;\n\t\t}\n\t</style>\n</head>\n\n<body>\n\t<h1>404</h1>\n\n\t<p>The file <strong>{{path}}</strong> does not exist.</p>\n\t<p><a href=\'https://github.com/gobblejs/gobble/wiki/Troubleshooting\'>See the troubleshooting page</a> if you\'re having problems getting your build to work as expected.</p>\n</body>\n</html>');

var entities = {
	'&': '&amp;',
	'<': '&lt;',
	'>': '&gt;',
	'"': '&quot;',
	"'": '&#39;',
	'/': '&#x2F;'
};

var colors = {
	37: 'white',
	90: 'grey',
	30: 'black',
	34: 'blue',
	36: 'cyan',
	32: 'green',
	35: 'magenta',
	31: 'red',
	33: 'yellow'
};
function serveError(error, request, response) {
	var html = undefined; // should be a block-scoped const, but jshint...

	if (error.gobble === 'WAITING') {
		response.statusCode = 420;
		response.write(waitingTemplate());

		response.end();
	} else if (error.code === 'ENOENT') {
		html = notfoundTemplate({
			path: error.path
		});

		response.statusCode = 404;
		response.write(html);

		response.end();
	} else {
		var message = escape(error.original ? error.original.message || error.original : error.message || error);
		var filename = error.original ? error.original.filename : error.filename;

		html = errTemplate({
			id: error.id,
			message: message.replace(/\[(\d+)m/g, function (match, $1) {
				var color = undefined;

				if (match === '[39m') {
					return '</span>';
				}

				if (color = colors[$1]) {
					return '<span style="color:' + color + ';">';
				}

				return '';
			}), // remove colors
			stack: prepareStack(error.stack),
			filemessage: filename ? '<p>The error occurred while processing <strong>' + filename + '</strong>.</p>' : ''
		});

		// turn filepaths into links
		html = html.replace(/([>\s\(])(&#x2F[^\s\):<]+)/g, function (match, $1, $2) {
			return $1 + '<a href="/__gobble__' + $2 + '">' + $2 + '</a>';
		});

		response.statusCode = 500;
		response.write(html);

		response.end();
	}
}

function prepareStack(stack) {
	return stack.split('\n').filter(function (line) {
		return line !== 'Error';
	}).map(function (line) {
		return '<li>' + escape(line.trim()) + '</li>';
	}).join('');
}

function escape(str) {
	return (str || '').replace(/[&<>"'\/]/g, function (char) {
		return entities[char];
	});
}

function handleRequest(srcDir, error, sourcemapPromises, request, response) {
	var parsedUrl = url$1.parse(request.url);
	var pathname = parsedUrl.pathname;

	var filepath = undefined;

	if (error) {
		if (pathname.substr(0, 11) === '/__gobble__') {
			var message = error.original && error.original.message || error.message || '';
			filepath = pathname.substring(11);

			// only allow links to files that we're actually interested in, not
			// the whole damn filesystem
			if (~message.indexOf(filepath) || ~error.stack.indexOf(filepath)) {
				return serveFile(pathname.substring(11), request, response);
			}
		}

		serveError(error, request, response);
		return sander.Promise.resolve();
	}

	filepath = path.join(srcDir, pathname);

	if (path.extname(filepath) === '.map') {
		return serveSourcemap(filepath, sourcemapPromises, request, response)['catch'](function (err) {
			return serveError(err, request, response);
		});
	}

	return sander.stat(filepath).then(function (stats) {
		if (stats.isDirectory()) {
			// might need to redirect from `foo` to `foo/`
			if (pathname.slice(-1) !== '/') {
				response.setHeader('Location', pathname + '/' + (parsedUrl.search || ''));
				response.writeHead(301);

				response.end();
			} else {
				return serveDir(filepath, request, response);
			}
		} else {
			return serveFile(filepath, request, response);
		}
	}, function (err) {
		return serveError(err, request, response);
	});
}

function serve(node) {
	var options = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];

	var port = options.port || 4567;
	var gobbledir = path.resolve(options.gobbledir || process.env.GOBBLE_TMP_DIR || '.gobble');
	var task = session.create({ gobbledir: gobbledir });

	var buildStarted = Date.now();
	var watchTask = undefined;
	var srcDir = undefined;
	var sourcemapPromises = undefined;
	var server = undefined;
	var serverReady = undefined;
	var lrServer = undefined;
	var lrServerReady = undefined;
	var built = false;
	var firedReadyEvent = false;
	var error = { gobble: 'WAITING' };

	task.resume = function (n) {
		node = n;
		watchTask = node.createWatchTask();

		watchTask.on('info', function (details) {
			return task.emit('info', details);
		});

		watchTask.on('error', function (err) {
			error = err;
			task.emit('error', err);
		});

		var buildStart = undefined;
		watchTask.on('build:start', function () {
			return buildStart = Date.now();
		});

		watchTask.on('build:end', function (dir) {
			error = null;
			sourcemapPromises = {};
			srcDir = dir;

			built = true;

			task.emit('built');

			task.emit('info', {
				code: 'BUILD_COMPLETE',
				duration: Date.now() - buildStart
			});

			if (!firedReadyEvent && serverReady) {
				task.emit('ready');
				firedReadyEvent = true;
			}

			if (!lrServerReady) {
				return;
			}

			lrServer.changed({ body: { files: '*' } });
		});
	};

	task.close = function () {
		if (node) {
			node.stop();
		}

		return new sander.Promise(function (fulfil) {
			session.destroy();
			server.removeAllListeners();
			server.close(fulfil);
		});
	};

	task.pause = function () {
		error = { gobble: 'WAITING' };

		buildStarted = Date.now();

		if (node) {
			node.stop();
		}

		node = null;

		return cleanup(gobbledir);
	};

	server = http.createServer();

	server.on('error', function (err) {
		if (err.code === 'EADDRINUSE') {
			// We need to create our own error, so we can pass along port info
			err = new GobbleError({
				port: port,
				code: 'PORT_IN_USE',
				message: 'port ' + port + ' is already in use'
			});
		}

		task.emit('error', err);

		process.exit(1);
	});

	server.listen(port, function () {
		serverReady = true;

		if (!firedReadyEvent && built) {
			task.emit('ready');
			firedReadyEvent = true;
		}

		task.emit('info', {
			port: port,
			code: 'SERVER_LISTENING'
		});
	});

	server.on('request', function (request, response) {
		handleRequest(srcDir, error, sourcemapPromises, request, response)['catch'](function (err) {
			return task.emit('error', err);
		});
	});

	lrServer = tinyLr();
	lrServer.error = function (err) {
		if (err.code === 'EADDRINUSE') {
			task.emit('warning', 'a livereload server is already running (perhaps in a separate gobble process?). Livereload will not be available for this session');
		} else {
			task.emit('error', err);
		}
	};

	lrServer.listen(35729, function () {
		lrServerReady = true;
		task.emit('info', {
			code: 'LIVERELOAD_RUNNING'
		});
	});

	cleanup(gobbledir).then(function () {
		return task.resume(node);
	}, function (err) {
		return task.emit('error', err);
	});

	return task;
}

var whitelist = { '.js': true, '.css': true };
function flattenSourcemaps(inputdir, outputdir, base, task) {
	return sander.lsr(inputdir).then(function (files) {
		var jsAndCss = files.filter(function (file) {
			return whitelist[path.extname(file)];
		});

		return mapSeries(jsAndCss, function (file) {
			return load(path.resolve(inputdir, file)).then(function (chain) {
				if (chain) {
					return chain.write(path.resolve(outputdir, file), { base: base });
				}
			})['catch'](function (err) {
				task.emit('error', err);
			});
		});
	}).then(function () {
		return inputdir;
	});
}

function _build (node, options) {
	if (!options || !options.dest) {
		throw new GobbleError({
			code: 'MISSING_DEST_DIR',
			task: 'build'
		});
	}

	var gobbledir = path.resolve(options.gobbledir || process.env.GOBBLE_TMP_DIR || '.gobble-build');
	var dest = options.dest;

	// the return value is an EventEmitter...
	var task = session.create({ gobbledir: gobbledir });
	var promise = undefined;
	var previousDetails = undefined;

	function build() {
		task.emit('info', {
			code: 'BUILD_START'
		});
		node.start();

		node.on('info', function (details) {
			if (details === previousDetails) return;
			previousDetails = details;
			task.emit('info', details);
		});

		return node.ready().then(function (inputdir) {
			return sander.copydir(inputdir).to(dest).then(function () {
				return flattenSourcemaps(inputdir, dest, dest, task);
			});
		}).then(function () {
			return node.stop();
		}); // TODO should not need to stop...
	}

	promise = cleanup(gobbledir).then(function () {
		return sander.readdir(dest).then(function (files) {
			if (files.length && !options.force) {
				throw new GobbleError({
					message: 'destination folder (' + dest + ') is not empty',
					code: 'DIR_NOT_EMPTY',
					path: dest
				});
			}

			return cleanup(dest).then(build);
		}, build);
	}).then(function () {
		task.emit('complete');
		session.destroy();
	}, function (err) {
		session.destroy();
		task.emit('error', err);
		throw err;
	});

	// that does double duty as a promise
	task.then = function () {
		return promise.then.apply(promise, arguments);
	};

	task['catch'] = function () {
		return promise['catch'].apply(promise, arguments);
	};

	return task;
}

function watch(node, options) {
	if (!options || !options.dest) {
		throw new GobbleError({
			code: 'MISSING_DEST_DIR',
			task: 'watch'
		});
	}

	var gobbledir = require('path').resolve(options.gobbledir || process.env.GOBBLE_TMP_DIR || '.gobble-watch');
	var task = session.create({ gobbledir: gobbledir });

	var watchTask = undefined;

	task.resume = function (n) {
		node = n;
		watchTask = node.createWatchTask();

		watchTask.on('info', function (details) {
			return task.emit('info', details);
		});
		watchTask.on('error', function (err) {
			return task.emit('error', err);
		});

		var buildStart = undefined;
		watchTask.on('build:start', function () {
			return buildStart = Date.now();
		});

		watchTask.on('build:end', function (dir) {
			var dest = options.dest;

			sander.rimraf(dest).then(function () {
				return sander.copydir(dir).to(dest);
			}).then(function () {
				var sourcemapProcessStart = Date.now();

				task.emit('info', {
					code: 'SOURCEMAP_PROCESS_START',
					progressIndicator: true
				});

				return flattenSourcemaps(dir, dest, dest, task).then(function () {
					task.emit('info', {
						code: 'SOURCEMAP_PROCESS_COMPLETE',
						duration: Date.now() - sourcemapProcessStart
					});

					task.emit('info', {
						code: 'BUILD_COMPLETE',
						duration: Date.now() - buildStart,
						watch: true
					});
				});
			}).then(function () {
				return task.emit('built', dest);
			})['catch'](function (err) {
				return task.emit('error', err);
			});
		});
	};

	task.close = function () {
		watchTask.close();
		session.destroy();

		return sander.Promise.resolve(); // for consistency with serve task
	};

	task.pause = function () {
		if (watchTask) {
			watchTask.close();
		}

		watchTask = null;
		return cleanup(gobbledir);
	};

	cleanup(gobbledir).then(function () {
		return task.resume(node);
	}, function (err) {
		return task.emit('error', err);
	});

	return task;
}

// TODO remove this in a future version
function enforceCorrectArguments(options) {
	if (options !== undefined && typeof options !== 'object') {
		throw new Error('As of gobble 0.9.0, you cannot pass multiple strings to .grab() and .moveTo(). Use path.join() instead');
	}
}

var Node = (function (_EventEmitter2) {
	babelHelpers_inherits(Node, _EventEmitter2);

	function Node() {
		babelHelpers_classCallCheck(this, Node);

		// initialise event emitter
		_EventEmitter2.call(this, { wildcard: true });

		this._gobble = true; // makes life easier for e.g. gobble-cli

		this.counter = 1;
		this.inspectTargets = [];
	}

	// This gets overwritten each time this.ready is overwritten. Until
	// the first time that happens, it's a noop

	Node.prototype._abort = function _abort() {};

	Node.prototype._findCreator = function _findCreator() {
		return this;
	};

	Node.prototype.build = function build(options) {
		return _build(this, options);
	};

	Node.prototype.createWatchTask = function createWatchTask() {
		var node = this;
		var watchTask = new eventemitter2.EventEmitter2({ wildcard: true });

		// TODO is this the best place to handle this stuff? or is it better
		// to pass off the info to e.g. gobble-cli?
		var previousDetails = undefined;

		node.on('info', function (details) {
			if (details === previousDetails) return;
			previousDetails = details;
			watchTask.emit('info', details);
		});

		var buildScheduled = undefined;

		node.on('invalidate', function (changes) {
			// A node can depend on the same source twice, which will result in
			// simultaneous rebuilds unless we defer it to the next tick
			if (!buildScheduled) {
				buildScheduled = true;
				watchTask.emit('info', {
					changes: changes,
					code: 'BUILD_INVALIDATED'
				});

				process.nextTick(build);
			}
		});

		node.on('error', handleError);

		function build() {
			buildScheduled = false;

			watchTask.emit('build:start');

			node.ready().then(function (outputdir) {
				watchTask.emit('build:end', outputdir);
			})['catch'](handleError);
		}

		function handleError(e) {
			if (e === ABORTED) {
				// these happen shortly after an invalidation,
				// we can ignore them
				return;
			} else {
				watchTask.emit('error', e);
			}
		}

		watchTask.close = function () {
			return node.stop();
		};

		this.start();
		process.nextTick(build);

		return watchTask;
	};

	Node.prototype.exclude = function exclude(patterns, options) {
		if (typeof patterns === 'string') {
			patterns = [patterns];
		}
		return new Transformer(this, include, { patterns: patterns, exclude: true, id: options && options.id });
	};

	Node.prototype.getChanges = function getChanges(inputdir) {
		var _this = this;

		var files = sander.lsrSync(inputdir);

		if (!this._files) {
			this._files = files;
			this._checksums = {};

			files.forEach(function (file) {
				_this._checksums[file] = crc32(sander.readFileSync(inputdir, file));
			});

			return files.map(function (file) {
				return { file: file, added: true };
			});
		}

		var added = files.filter(function (file) {
			return ! ~_this._files.indexOf(file);
		}).map(function (file) {
			return { file: file, added: true };
		});
		var removed = this._files.filter(function (file) {
			return ! ~files.indexOf(file);
		}).map(function (file) {
			return { file: file, removed: true };
		});

		var maybeChanged = files.filter(function (file) {
			return ~_this._files.indexOf(file);
		});

		var changed = [];

		maybeChanged.forEach(function (file) {
			var checksum = crc32(sander.readFileSync(inputdir, file));

			if (!compareBuffers(checksum, _this._checksums[file])) {
				changed.push({ file: file, changed: true });
				_this._checksums[file] = checksum;
			}
		});

		return added.concat(removed).concat(changed);
	};

	Node.prototype.grab = function grab$$(src, options) {
		enforceCorrectArguments(options);
		return new Transformer(this, grab, { src: src, id: options && options.id });
	};

	// Built-in transformers

	Node.prototype.include = function include$$(patterns, options) {
		if (typeof patterns === 'string') {
			patterns = [patterns];
		}
		return new Transformer(this, include, { patterns: patterns, id: options && options.id });
	};

	Node.prototype.inspect = function inspect(target, options) {
		target = path.resolve(config.cwd, target);

		if (options && options.clean) {
			sander.rimraf(target);
		}

		this.inspectTargets.push(target);
		return this; // chainable
	};

	Node.prototype.map = function map(fn, userOptions) {
		warnOnce('node.map() is deprecated. You should use node.transform() instead for both file and directory transforms');
		return this.transform(fn, userOptions);
	};

	Node.prototype.moveTo = function moveTo$$(dest, options) {
		enforceCorrectArguments(options);
		return new Transformer(this, moveTo, { dest: dest, id: options && options.id });
	};

	Node.prototype.observe = function observe(fn, userOptions) {
		if (typeof fn === 'string') {
			fn = tryToLoad(fn);
		}

		return new Observer(this, fn, userOptions);
	};

	Node.prototype.observeIf = function observeIf(condition, fn, userOptions) {
		return condition ? this.observe(fn, userOptions) : this;
	};

	Node.prototype.serve = function serve$$(options) {
		return serve(this, options);
	};

	Node.prototype.transform = function transform(fn, userOptions) {
		if (typeof fn === 'string') {
			// TODO remove this for 0.9.0
			if (fn === 'sorcery') {
				warnOnce('Sourcemaps are flattened automatically as of gobble 0.8.0. You should remove the sorcery transformation from your build definition');
				return this;
			}

			fn = tryToLoad(fn);
		}

		// If function takes fewer than 3 arguments, it's a file transformer
		if (fn.length < 3) {
			var options = assign({}, fn.defaults, userOptions, {
				fn: fn,
				cache: {},
				userOptions: assign({}, userOptions)
			});

			if (typeof options.accept === 'string' || isRegExp(options.accept)) {
				options.accept = [options.accept];
			}

			return new Transformer(this, map, options, fn.id || fn.name);
		}

		// Otherwise it's a directory transformer
		return new Transformer(this, fn, userOptions);
	};

	Node.prototype.transformIf = function transformIf(condition, fn, userOptions) {
		return condition ? this.transform(fn, userOptions) : this;
	};

	Node.prototype.watch = function watch$$(options) {
		return watch(this, options);
	};

	return Node;
})(eventemitter2.EventEmitter2);

function tryToLoad(plugin) {
	try {
		return requireRelative('gobble-' + plugin, process.cwd());
	} catch (err) {
		if (err.message === 'Cannot find module \'gobble-' + plugin + '\'') {
			throw new GobbleError({
				message: 'Could not load gobble-' + plugin + ' plugin',
				code: 'PLUGIN_NOT_FOUND',
				plugin: plugin
			});
		} else {
			throw err;
		}
	}
}

var i$1 = 1;
function uid(postfix) {
	if (process.env.GOBBLE_RESET_UID === 'reset') {
		i$1 = 1;
		delete process.env.GOBBLE_RESET_UID;
	}

	return pad(i$1++) + (postfix ? '-' + postfix : '');
}

function pad(number) {
	return '' + (number < 10 ? '0' + number : number);
}

var Source = (function (_Node) {
	babelHelpers_inherits(Source, _Node);

	function Source(dir) {
		var _this = this;

		var options = arguments.length <= 1 || arguments[1] === undefined ? {} : arguments[1];
		babelHelpers_classCallCheck(this, Source);

		_Node.call(this);

		this.id = options.id || 'source';
		this.dir = dir;
		this.callbacks = [];
		this._entries = {};

		// Ensure the source exists, and is a directory
		try {
			var stats = sander.statSync(this.dir);

			if (!stats.isDirectory()) {
				this.file = dir;
				this.dir = undefined;

				this.uid = uid(this.id);

				this._ready = new sander.Promise(function (ok, fail) {
					_this._deferred = { ok: ok, fail: fail };
				});
			} else {
				this._ready = sander.Promise.resolve(this.dir);
			}
		} catch (err) {
			if (err.code === 'ENOENT') {
				throw new GobbleError({
					code: 'MISSING_DIRECTORY',
					path: dir,
					message: 'the ' + dir + ' directory does not exist'
				});
			}

			throw err;
		}

		this['static'] = options && options['static'];
	}

	Source.prototype.ready = function ready() {
		return this._ready;
	};

	Source.prototype.start = function start() {
		var _this2 = this;

		if (this._active || this['static']) {
			return;
		}

		this._active = true;

		// this is a file watch that isn't fully initialized
		if (this._deferred) {
			this._makeReady();
		}

		// make sure the file is in the appropriate target directory to start
		if (this.file) {
			sander.linkSync(this.file).to(this.targetFile);
		}

		var changed = {};

		var relay = debounce(function () {
			var changes = [];

			Object.keys(changed).forEach(function (path$$) {
				var type = changed[path$$];
				var change = { type: type, file: path.relative(_this2.dir, path$$) };

				type === 'add' && (change.added = true);
				type === 'change' && (change.changed = true);
				type === 'unlink' && (change.removed = true);

				changes.push(change);
			});

			_this2.emit('invalidate', _this2.changes = changes);
			changed = {};
		}, 100);

		if (this.dir) {
			(function () {
				_this2._dir = new pathwatcher.Directory(_this2.dir);
				var processDirEntries = function processDirEntries(err, entries, initial) {
					if (err) throw err;

					entries.forEach(function (entry) {
						if (_this2._entries[entry.path]) return;else if (!initial) {
							changed[entry.path] = 'add';
							relay();
						}

						_this2._entries[entry.path] = entry;

						if (entry instanceof pathwatcher.File) {
							entry.onDidChange(function () {
								changed[entry.path] = 'change';
								relay();
							});

							var doDelete = function doDelete() {
								_this2._entries[entry.path].unsubscribeFromNativeChangeEvents();
								_this2._entries[entry.path] = null;
								changed[entry.path] = 'unlink';
								relay();
							};

							entry.onDidDelete(doDelete);
							entry.onDidRename(doDelete);
						} else if (entry instanceof pathwatcher.Directory) {
							entry.onDidChange(function () {
								entry.getEntries(processDirEntries);
							});

							entry.getEntries(function (err, entries) {
								processDirEntries(err, entries, initial);
							});
						}
					});
				};

				_this2._dir.getEntries(processDirEntries);
				processDirEntries(null, [_this2._dir], true);
			})();
		}

		if (this.file) {
			this._fileWatcher = pathwatcher.watch(this.file, function (type) {
				if (type === 'change') sander.link(_this2.file).to(_this2.targetFile);
			});
		}
	};

	Source.prototype.stop = function stop() {
		var _this3 = this;

		if (this._dir) {
			Object.keys(this._entries).forEach(function (path$$) {
				_this3._entries[path$$].unsubscribeFromNativeChangeEvents();
				delete _this3._entries[path$$];
			});
			this._dir.unsubscribeFromNativeChangeEvents();
			this._dir = null;
		}

		if (this._fileWatcher) {
			this._fileWatcher.close();
			this._fileWatcher = null;
		}

		this._active = false;
	};

	Source.prototype.active = function active() {
		return this._active;
	};

	Source.prototype._findCreator = function _findCreator(filename) {
		try {
			sander.statSync(filename);
			return this;
		} catch (err) {
			return null;
		}
	};

	Source.prototype._makeReady = function _makeReady() {
		this.dir = path.resolve(session.config.gobbledir, this.uid);
		this.targetFile = path.resolve(this.dir, path.basename(this.file));

		try {
			sander.mkdirSync(this.dir);
			this._deferred.ok(this.dir);
		} catch (e) {
			this._deferred.fail(e);
			throw e;
		}

		delete this._deferred;
	};

	return Source;
})(Node);

function mergeDirectories(src, dest) {
	return sander.stat(dest).then(function (stats) {
		if (stats.isDirectory()) {
			// If it's a symlinked dir, we need to convert it to a real dir.
			// Suppose linked-foo/ is a symlink of foo/, and we try to copy
			// the contents of bar/ into linked-foo/ - those files will end
			// up in foo, which is definitely not what we want
			return sander.lstat(dest).then(function (stats) {
				if (stats.isSymbolicLink()) {
					return convertToRealDir(dest);
				}
			}).then(function () {
				return sander.readdir(src).then(function (files) {
					var promises = files.map(function (filename) {
						return mergeDirectories(src + path.sep + filename, dest + path.sep + filename);
					});

					return sander.Promise.all(promises);
				});
			});
		}

		// exists, and is file - overwrite
		return sander.unlink(dest).then(link);
	}, link); // <- failed to stat, means dest doesn't exist

	function link() {
		return sander.symlinkOrCopy(src).to(dest);
	}
}

// TODO make this async
function convertToRealDir(symlinkPath) {
	var originalPath = sander.realpathSync(symlinkPath);

	sander.unlinkSync(symlinkPath);
	sander.mkdirSync(symlinkPath);

	sander.readdirSync(originalPath).forEach(function (filename) {
		sander.symlinkOrCopySync(originalPath, filename).to(symlinkPath, filename);
	});
}

var Merger = (function (_Node) {
	babelHelpers_inherits(Merger, _Node);

	function Merger(inputs, options) {
		babelHelpers_classCallCheck(this, Merger);

		_Node.call(this);

		this.inputs = inputs;
		this.id = uid(options && options.id || 'merge');
	}

	Merger.prototype.ready = function ready() {
		var _this = this;

		var aborted = undefined;
		var index = undefined;
		var outputdir = undefined;

		if (!this._ready) {
			this._abort = function () {
				// allows us to short-circuit operations at various points
				aborted = true;
				_this._ready = null;
			};

			index = this.counter++;
			outputdir = path.resolve(session.config.gobbledir, this.id, '' + index);

			this._ready = sander.mkdir(outputdir).then(function () {
				var start = undefined;
				var inputdirs = [];

				return mapSeries(_this.inputs, function (input, i) {
					if (aborted) throw ABORTED;
					return input.ready().then(function (inputdir) {
						return inputdirs[i] = inputdir;
					});
				}).then(function () {
					start = Date.now();

					_this.emit('info', {
						code: 'MERGE_START',
						id: _this.id,
						progressIndicator: true
					});

					return mapSeries(inputdirs, function (inputdir) {
						if (aborted) throw ABORTED;
						return mergeDirectories(inputdir, outputdir);
					});
				}).then(function () {
					if (aborted) throw ABORTED;

					_this._cleanup(index);

					_this.emit('info', {
						code: 'MERGE_COMPLETE',
						id: _this.id,
						duration: Date.now() - start
					});

					return outputdir;
				});
			});
		}

		return this._ready;
	};

	Merger.prototype.start = function start() {
		var _this2 = this;

		if (this._active) return;
		this._active = true;

		this._oninvalidate = function (changes) {
			_this2._abort(changes);
			_this2.emit('invalidate', changes);
		};

		this._oninfo = function (details) {
			return _this2.emit('info', details);
		};

		this.inputs.forEach(function (input) {
			input.on('invalidate', _this2._oninvalidate);
			input.on('info', _this2._oninfo);

			input.start();
		});
	};

	Merger.prototype.stop = function stop() {
		var _this3 = this;

		this.inputs.forEach(function (input) {
			input.off('invalidate', _this3._oninvalidate);
			input.off('info', _this3._oninfo);

			input.stop();
		});

		this._active = false;
	};

	Merger.prototype.active = function active() {
		return this._active;
	};

	Merger.prototype._cleanup = function _cleanup(index) {
		var dir = path.join(session.config.gobbledir, this.id);

		// Remove everything except the last successful output dir.
		// Use readdirSync to eliminate race conditions
		sander.readdirSync(dir).filter(function (file) {
			return file !== '.cache' && +file < index;
		}).forEach(function (file) {
			return sander.rimrafSync(dir, file);
		});
	};

	Merger.prototype._findCreator = function _findCreator(filename) {
		var i = this.inputs.length;
		var node = undefined;

		while (i--) {
			node = this.inputs[i];
			if (node._findCreator(filename)) {
				return node;
			}
		}

		return null;
	};

	return Merger;
})(Node);

var queue = new Queue();

function makeLog(node) {
	var _arguments = arguments;
	var event = arguments.length <= 1 || arguments[1] === undefined ? 'info' : arguments[1];

	return function (details) {
		// it's a string that may be formatted
		if (typeof details === 'string') {
			node.emit(event, { progressIndicator: true, message: details, parameters: Array.prototype.slice.call(_arguments, 1) });
		} else {
			// otherwise, pass through
			node.emit(event, details);
		}
	};
}

var Observer = (function (_Node) {
	babelHelpers_inherits(Observer, _Node);

	function Observer(input, fn, options, id) {
		babelHelpers_classCallCheck(this, Observer);

		_Node.call(this);

		this.input = input;

		this.fn = fn;
		this.options = assign({}, options);

		this.name = id || fn.id || fn.name || 'unknown';
		this.id = uid(this.name);
	}

	Observer.prototype.ready = function ready() {
		var _this = this;

		var observation = undefined;

		if (!this._ready) {
			observation = {
				node: this,
				log: makeLog(this),
				env: config.env,
				sander: sander
			};

			this._abort = function () {
				_this._ready = null;
				observation.aborted = true;
			};

			this._ready = this.input.ready().then(function (inputdir) {
				return queue.add(function (fulfil, reject) {
					_this.emit('info', {
						code: 'TRANSFORM_START', // TODO
						progressIndicator: true,
						id: _this.id
					});

					var start = Date.now();
					var called = false;

					var callback = function callback(err) {
						if (called) return;
						called = true;

						if (observation.aborted) {
							reject(ABORTED);
						} else if (err) {
							var stack = err.stack || new Error().stack;

							var _extractLocationInfo = extractLocationInfo(err);

							var file = _extractLocationInfo.file;
							var line = _extractLocationInfo.line;
							var column = _extractLocationInfo.column;

							var gobbleError = new GobbleError({
								inputdir: inputdir,
								stack: stack, file: file, line: line, column: column,
								message: 'observation failed',
								id: _this.id,
								code: 'TRANSFORMATION_FAILED', // TODO
								original: err
							});

							reject(gobbleError);
						} else {
							_this.emit('info', {
								code: 'TRANSFORM_COMPLETE', // TODO
								id: _this.id,
								duration: Date.now() - start
							});

							fulfil(inputdir);
						}
					};

					try {
						observation.changes = _this.input.changes || _this.getChanges(inputdir);

						var promise = _this.fn.call(observation, inputdir, assign({}, _this.options), callback);
						var promiseIsPromise = promise && typeof promise.then === 'function';

						if (!promiseIsPromise && _this.fn.length < 3) {
							throw new Error('Observer ' + _this.id + ' did not return a promise and did not accept callback');
						}

						if (promiseIsPromise) {
							promise.then(function () {
								return callback();
							}, callback);
						}
					} catch (err) {
						callback(err);
					}
				});
			});
		}

		return this._ready;
	};

	Observer.prototype.start = function start() {
		var _this2 = this;

		if (this._active) {
			return;
		}

		this._active = true;

		// Propagate invalidation events and information
		this._oninvalidate = function (changes) {
			_this2._abort();
			_this2.emit('invalidate', changes);
		};

		this._oninfo = function (details) {
			return _this2.emit('info', details);
		};

		this.input.on('invalidate', this._oninvalidate);
		this.input.on('info', this._oninfo);

		return this.input.start();
	};

	Observer.prototype.stop = function stop() {
		this.input.off('invalidate', this._oninvalidate);
		this.input.off('info', this._oninfo);

		this.input.stop();
		this._active = false;
	};

	Observer.prototype.active = function active() {
		return this._active;
	};

	return Observer;
})(Node);

var Transformer = (function (_Node) {
	babelHelpers_inherits(Transformer, _Node);

	function Transformer(input, transformer, options, id) {
		var _this = this;

		babelHelpers_classCallCheck(this, Transformer);

		_Node.call(this);

		this.input = input;

		this.transformer = transformer;
		this.options = assign({}, options);

		this.name = id || this.options.id || transformer.id || transformer.name || 'unknown';
		this.id = uid(this.name);

		// Double callback style deprecated as of 0.6.x. TODO remove this eventually
		if (transformer.length === 5) {
			warnOnce('The gobble plugin API has changed - the "%s" transformer should take a single callback. See https://github.com/gobblejs/gobble/wiki/Troubleshooting for more info', this.name);

			this.transformer = function (inputdir, outputdir, options, callback) {
				return transformer.call(_this, inputdir, outputdir, options, function () {
					return callback();
				}, callback);
			};
		}
	}

	Transformer.prototype.ready = function ready() {
		var _this2 = this;

		var outputdir = undefined;
		var transformation = undefined;

		if (!this._ready) {
			transformation = {
				node: this,
				cachedir: path.resolve(session.config.gobbledir, this.id, '.cache'),
				log: makeLog(this),
				env: config.env,
				sander: sander
			};

			this._abort = function () {
				_this2._ready = null;
				transformation.aborted = true;
			};

			outputdir = path.resolve(session.config.gobbledir, this.id, '' + this.counter++);

			this._ready = this.input.ready().then(function (inputdir) {
				return sander.mkdir(outputdir).then(function () {
					return queue.add(function (fulfil, reject) {
						_this2.emit('info', {
							code: 'TRANSFORM_START',
							progressIndicator: true,
							id: _this2.id
						});

						var start = Date.now();
						var called = false;

						var callback = function callback(err) {
							if (called) return;
							called = true;

							if (transformation.aborted) {
								reject(ABORTED);
							} else if (err) {
								var stack = err.stack || new Error().stack;

								var _extractLocationInfo = extractLocationInfo(err);

								var file = _extractLocationInfo.file;
								var line = _extractLocationInfo.line;
								var column = _extractLocationInfo.column;

								var gobbleError = new GobbleError({
									inputdir: inputdir, outputdir: outputdir,
									stack: stack, file: file, line: line, column: column,
									message: 'transformation failed',
									id: _this2.id,
									code: 'TRANSFORMATION_FAILED',
									original: err
								});

								reject(gobbleError);
							} else {
								_this2.emit('info', {
									code: 'TRANSFORM_COMPLETE',
									id: _this2.id,
									duration: Date.now() - start
								});

								_this2._cleanup(outputdir);
								fulfil(outputdir);
							}
						};

						try {
							transformation.changes = _this2.input.changes || _this2.getChanges(inputdir);

							var promise = _this2.transformer.call(transformation, inputdir, outputdir, assign({}, _this2.options), callback);

							if (promise && typeof promise.then === 'function') {
								promise.then(function () {
									return callback();
								}, callback);
							}
						} catch (err) {
							callback(err);
						}
					});
				});
			});
		}

		return this._ready;
	};

	Transformer.prototype.start = function start() {
		var _this3 = this;

		if (this._active) {
			return;
		}

		this._active = true;

		// Propagate invalidation events and information
		this._oninvalidate = function (changes) {
			_this3._abort();
			_this3.emit('invalidate', changes);
		};

		this._oninfo = function (details) {
			return _this3.emit('info', details);
		};

		this.input.on('invalidate', this._oninvalidate);
		this.input.on('info', this._oninfo);

		return sander.mkdir(session.config.gobbledir, this.id).then(function () {
			return _this3.input.start();
		});
	};

	Transformer.prototype.stop = function stop() {
		this.input.off('invalidate', this._oninvalidate);
		this.input.off('info', this._oninfo);

		this.input.stop();
		this._active = false;
	};

	Transformer.prototype.active = function active() {
		return this._active;
	};

	Transformer.prototype._cleanup = function _cleanup(latest) {
		var dir = path.join(session.config.gobbledir, this.id);

		// Remove everything except the last successful outputdir and the cachedir
		// Use readdirSync to eliminate race conditions
		sander.readdirSync(dir).filter(function (file) {
			return file !== '.cache' && path.resolve(dir, file) !== latest;
		}).forEach(function (file) {
			return sander.rimrafSync(dir, file);
		});
	};

	return Transformer;
})(Node);

function fail() {
	throw new Error('could not process input. Usage:\n    node2 = gobble(node1)\n    node = gobble(\'some/dir\')\n    node = gobble([node1, node2[, nodeN]) (inputs can also be strings)\n    See ' + chalk.cyan('https://github.com/gobblejs/gobble/wiki') + ' for more info.');
}

var sources$1 = {};

function getNode(input, options) {
	if (input._gobble) {
		return input;
	}

	if (isArray(input)) {
		input = input.map(ensureNode);
		return new Merger(input, options);
	}

	if (isString(input)) {
		input = path.resolve(config.cwd, input);
		return sources$1[input] || (sources$1[input] = new Source(input, options));
	}

	fail();
}

function ensureNode(input) {
	return getNode(input);
}

function gobble(input, options) {
	// gobble takes 1 or two arguments. The second must be an options object
	if (arguments.length > 2 || options && (typeof options !== 'object' || options._gobble)) {
		fail();
	}

	return getNode(input, options);
}

gobble.env = function (env) {
	if (arguments.length) {
		config.env = env;
	}

	return config.env;
};

gobble.cwd = function () {
	if (arguments.length) {
		config.cwd = path.resolve.apply(null, arguments);
	}

	return config.cwd;
};

gobble.sander = sander;

module.exports = gobble;
//# sourceMappingURL=gobble.js.map