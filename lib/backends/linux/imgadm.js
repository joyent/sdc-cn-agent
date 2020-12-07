/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2020 Joyent, Inc.
 */

/*
 * A light wrapper around the `imgadm` tool.
 */

var assert = require('assert-plus');
var child_process = require('child_process'),
    spawn = child_process.spawn,
    execFile = child_process.execFile;
var format = require('util').format;
var crypto = require('crypto');
var fs = require('fs');
var zfs = require('zfs').zfs;

const IMGADM = '/usr/triton/bin/imgadm';
const ZFS = '/sbin/zfs';

try {
    var IMG = require('/usr/triton/node-imgadm/lib/IMG');
} catch (e) {
    console.warn('warning: cannot load /usr/triton/node-imgadm/lib/IMG.js, '
        + 'falling back to slower image gets');
}



// ---- globals

var UUID_RE = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;


// ---- internal support stuff

function objCopy(obj) {
    var copy = {};
    Object.keys(obj).forEach(function (k) {
        copy[k] = obj[k];
    });
    return copy;
}



// ---- main functionality

/**
 * Import the given image.
 *
 * It is up to the caller to ensure this UUID is not already installed.
 *
 * @param {Object} options:
 *      - @param {UUID} uuid - The UUID of the remote image to import.
 *      - @param {String} zpool - The zpool to which to import.
 *      - @param {Object} log - A log object on which to call log.info
 *        for successful run output.
 * @param callback {Function} `function (err)`
 */
function importImage(options, callback) {
    assert.ok(options, 'options');
    assert.ok(options.uuid && UUID_RE.test(options.uuid), 'options.uuid');
    assert.ok(options.zpool && typeof (options.zpool) === 'string',
        'options.zpool');
    assert.ok(options.log, 'options.log');
    assert.optionalString(options.source, 'options.source');
    assert.optionalBool(options.zstream, 'options.zstream');

    // Hack to workaround OS-2203 (imgadm import not supporting concurrent
    // imports).
    // 1hr timeout -- same as the CNAPI task in the provision workflow
    options.timeout = 1000 * 60 * 60;
    waitForConcurrentImageImport(options, function (waitErr) {
        if (waitErr) {
            callback(waitErr);
            return;
        }

        var argv = [IMGADM, 'import', '-q', '-P',
                    options.zpool, options.uuid];
        if (options.source) {
            argv.push('-S', options.source);
        }
        if (options.zstream) {
            argv.push('--zstream');
        }

        var env = objCopy(process.env);
        // Get 'debug' level logging in imgadm >=2.6.0 without triggering trace
        // level logging in imgadm versions before that. Trace level logging is
        // too much here.
        env.IMGADM_LOG_LEVEL = 'debug';
        var execOpts = {
            encoding: 'utf8',
            env: env
        };
        options.log.info('Calling: ' + argv.join(' '));
        var child = spawn(argv[0], argv.slice(1), execOpts);
        var stdout = [];
        child.stdout.setEncoding('utf8');
        child.stdout.on('data', function (chunk) {
            stdout.push(chunk);
        });

        var stderr = [];
        child.stderr.setEncoding('utf8');
        child.stderr.on('data', function (chunk) {
            stderr.push(chunk);
        });

        var exitCode, signal, failed;
        child.on('exit', function (code_, signal_) {
            exitCode = code_;
            signal = signal_;
            failed = Boolean(exitCode || signal);
        });

        // TJ tells me that 'close' always comes after the 'exit' event.
        child.on('close', function finish() {
            stdout = stdout.join('');
            stderr = stderr.join('');

            options.log[failed ? 'warn' : 'info'](
                {
                    argv: argv,
                    env: env,
                    exitCode: exitCode,
                    signal: signal,
                    stdout: stdout,
                    stderr: stderr
                },
                '%s importing image %s to zpool %s',
                (failed ? 'Error' : 'Success'),
                options.uuid,
                options.zpool);
            if (failed) {
                // With 'imgadm -E' the last line of output is a structured
                // bunyan log line and the 'err' field will be error info.
                var err;
                var errLine = stderr.trim().split(/\n/g).slice(-1)[0];
                try {
                    var errInfo = JSON.parse(errLine).err; // imgadm Error info
                    err = new Error(errInfo.message);
                    err.body = errInfo;
                } catch (e) {
                    // If the last line is not parseable JSON, then it is likely
                    // some crash output where we want more than the last line.
                    // Let's try to get the whole stack trace up to a limit
                    var LIMIT = 1024;
                    var stack = stderr.trim().split(/\n\n/g).slice(-1)[0];
                    if (stack.length > LIMIT) {
                        stack = stack.slice(-LIMIT);
                    }
                    err = new Error(stack);
                }
                callback(err);
            } else {
                callback();
            }
        });
    });
}


function waitForConcurrentImageImport(options, callback) {
    assert.ok(options, 'options');
    assert.ok(options.uuid && UUID_RE.test(options.uuid), 'options.uuid');
    assert.ok(options.zpool && typeof (options.zpool) === 'string',
        'options.zpool');
    assert.ok(options.timeout, 'options.timeout');
    assert.ok(options.log, 'options.log');

    var end = Date.now() + options.timeout;
    var INTERVAL = 10 * 1000; // 10s
    // Per -partial name in imgadm:
    // JSSTYLED
    // <https://github.com/joyent/smartos-live/blob/master/src/img/lib/imgadm.js#L1571-L1576>
    var partialDsName = format('%s/%s-partial', options.zpool, options.uuid);

    setTimeout(pollOnce, Math.random() * 1000);

    function pollOnce() {
        zfs.list(partialDsName, function (err, ds) {
            if (ds) {
                var now = Date.now();
                if (now >= end) {
                    callback(new Error(format('timeout waiting for partial'
                        + ' dataset "%s" to be removed', partialDsName)));
                } else {
                    options.log.info('"%s" dataset exists, waiting',
                        partialDsName);
                    setTimeout(pollOnce, INTERVAL);
                }
            } else if (err && err.message &&
                err.message.indexOf('dataset does not exist'))
            {
                // Expected error is:
                // JSSTYLED
                //      Command failed: cannot open 'zones/fac31b04-af9e-4c55-8f9d-74b0eead711f': dataset does not exist
                callback();
            } else {
                callback(new Error(format('unexpected error listing partial'
                    + ' dataset "%s"', partialDsName)));
            }
        });
    }
}

/**
 * Create an image from a given VM.
 *
 */
function createImage(options, callback) {
    assert.ok(options, 'options');
    assert.ok(options.compression, 'options.compression');
    assert.ok(options.imgapi_url, 'options.imgapi_url');
    assert.ok(options.manifest, 'options.manifest');
    assert.ok(options.uuid, 'options.uuid');
    assert.ok(options.manifest.uuid, 'options.manifest.uuid');
    // optionalBool(options.incremental);
    // optionalString(options.prepare_image_script);
    var log = options.log;

    var fid = crypto.randomBytes(4).readUInt32LE(0);
    var manifestFile = '/var/tmp/.provisioner-create-image-manifest-'
        + fid + '.json';
    fs.writeFileSync(manifestFile, JSON.stringify(options.manifest));
    var argv = [
        IMGADM,
        // Note: Verbose output disabled by now while imgadm 2.5.0 is in play
        // with much too verbose trace level output.
        // '-v',
        '-E',
        'create', '-m', manifestFile,
        '-c', options.compression,
        options.uuid,
        '--publish', options.imgapi_url
    ];
    if (options.incremental) {
        argv.push('--incremental');
    }
    if (options.max_origin_depth) {
        argv.push('--max-origin-depth', options.max_origin_depth);
    }
    var prepareFile;
    if (options.prepare_image_script) {
        prepareFile = '/var/tmp/.provisioner-create-image-prepare-' + fid;
        fs.writeFileSync(prepareFile, options.prepare_image_script);
        argv.push('-s');
        argv.push(prepareFile);
    }
    var env = objCopy(process.env);
    // Get 'debug' level logging in imgadm >=2.6.0 without triggering trace
    // level logging in imgadm versions before that. Trace level logging is
    // too much here.
    env.IMGADM_LOG_LEVEL = 'debug';
    var execOpts = {
        env: env
    };
    log.info({argv: argv}, 'spawn imgadm create');
    var child = spawn(argv[0], argv.slice(1), execOpts);
    var stdout = [];
    child.stdout.setEncoding('utf8');
    child.stdout.on('data', function (chunk) {
        // TODO: could hook up progress here
        stdout.push(chunk);
    });
    var stderr = [];
    child.stderr.setEncoding('utf8');
    child.stderr.on('data', function (chunk) { stderr.push(chunk); });

    var exitCode, signal, failed;
    var nFinish = 0;
    child.on('exit', function (code_, signal_) {
        exitCode = code_;
        signal = signal_;
        failed = Boolean(exitCode || signal);
        finish();
    });
    child.on('close', finish);

    function finish() {
        nFinish++;
        if (nFinish < 2 || nFinish > 2) {
            return;
        }

        fs.unlinkSync(manifestFile);
        if (prepareFile) {
            fs.unlinkSync(prepareFile);
        }
        stdout = stdout.join('');
        stderr = stderr.join('');

        log[failed ? 'warn' : 'info'](
            {
                argv: argv,
                env: env,
                exitCode: exitCode,
                signal: signal,
                stdout: stdout,
                stderr: stderr
            },
            '%s creating and publishing image %s from VM %s',
            (failed ? 'Error' : 'Success'),
            options.manifest.uuid,
            options.uuid);
        if (failed) {
            // With 'imgadm -E' the last line of output is a structured
            // bunyan log line and the 'err' field will be error info.
            var err;
            var errLine = stderr.trim().split(/\n/g).slice(-1)[0];
            try {
                var errInfo = JSON.parse(errLine).err; // imgadm Error info
                err = new Error(errInfo.message);
                err.body = errInfo;
            } catch (e) {
                // If the last line is not parseable JSON, then it is likely
                // some crash output where we want more than the last line.
                // Let's try to get the whole stack trace up to a limit
                var LIMIT = 1024;
                var stack = stderr.trim().split(/\n\n/g).slice(-1)[0];
                if (stack.length > LIMIT) {
                    stack = stack.slice(-LIMIT);
                }
                err = new Error(stack);
            }
            callback(err);
        } else {
            callback();
        }
    }
}


/**
 * Get the given image.
 *
 * @param {Object} options:
 *      - @param {UUID} uuid - The UUID of the image
 *      - @param {String} zpool - Optional:  ZFS pool that contains the image.
 *      - @param {Object} log - A log object on which to call log.info
 *        for successful run output.
 * @param callback {Function} `function (err, image)`
 */
function getImage(options, callback) {
    assert.object(options, 'options');
    assert.uuid(options.uuid, 'options.uuid');
    assert.optionalString(options.pool, 'options.pool');
    assert.object(options.log, 'options.log');

    var argv = [IMGADM, 'get'];
    if (options.hasOwnProperty('zpool')) {
        argv.push('-P', options.zpool);
    }
    argv.push(options.uuid);
    options.log.trace({argv: argv}, 'getImage: exec imgadm get');
    execFile(argv[0], argv.slice(1), function (err, stdout, stderr) {
        options.log.info({err: err, stdout: stdout, stderr: stderr},
            'getImage: done imgadm get');
        if (err) {
            callback(new Error(format('error getting image %s:\n'
                + '    cmd: %s\n'
                + '    stderr: %s',
                options.uuid,
                argv.join(' '),
                stderr)));
            return;
        }
        var image = JSON.parse(stdout.trim()).manifest;
        callback(null, image);
    });
}


/**
 * Get the given image, less safely, but more quickly. See
 * <https://github.com/joyent/smartos-live/blob/master/src/img/lib/IMG.js>
 *
 * @param {Object} options:
 *      - @param {UUID} uuid - The UUID of the image
 *      - @param {Object} log - A log object on which to call log.info
 *        for successful run output.
 * @param callback {Function} `function (err, image)`
 */
function quickGetImage(opts, callback) {
    if (!IMG) {
        getImage(opts, callback);
        return;
    }

    // Note: we are *assuming* the 'zones' zpool. Fine for SDC.
    IMG.quickGetImage({
        uuid: opts.uuid,
        zpool: 'zones',
        log: opts.log
    }, function (err, imgInfo) {
        if (err) {
            callback(err);
        } else {
            callback(null, imgInfo.manifest);
        }
    });
}


/**
 * Sends a `zfs send` stream for the given image to a calling writable stream.
 *
 * @param {Object} opts:
 *      - @param {Object} image - The image manifest.
 *      - @param {UUID} stream - The writable stream
 *      - @param {Object} log - A log object on which to call log.info
 *        for successful run output.
 * @param callback {Function} `function (err)`
 */
function sendImageFile(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.image, 'opts.image');
    assert.object(opts.stream, 'opts.stream');
    assert.object(opts.log, 'opts.log');

    var argv = [ZFS, 'send'];
    if (opts.image.origin) {
        argv.push('-i');
        argv.push(format('zones/%s@final', opts.image.origin));
    }
    argv.push(format('zones/%s@final', opts.image.uuid));

    opts.log.debug({argv: argv}, 'sendImageFile: start zfs send');
    var zfsSend = spawn(argv[0], argv.slice(1));

    var zfsStderrChunks = [];
    zfsSend.stderr.on('data', function (chunk) {
        zfsStderrChunks.push(chunk);
    });

    var signal, code;
    zfsSend.on('exit', function (code_, signal_) {
        opts.log.debug({code: code_, signal: signal_},
            'sendImageFile: zfs send exited');
        code = code_;
        signal = signal_;
    });

    zfsSend.on('close', function () {
        if (code || signal) {
            var err = new Error(format('zfs send error:\n'
                + '    exit code: %s\n'
                + '    signal: %s\n'
                + '    cmd: %s\n'
                + '    stderr:%s',
                code,
                signal,
                argv.join(' '),
                zfsStderrChunks.join('')));
            opts.log.info({err: err, argv: argv, code: code},
                'sendImageFile: zfs send closed');
            callback(err);
        } else {
            opts.log.info({code: code}, 'sendImageFile: zfs send closed');
            callback();
        }
    });

    zfsSend.stdout.pipe(opts.stream);
}


// ---- exports

module.exports = {
    createImage: createImage,
    getImage: getImage,
    quickGetImage: quickGetImage,
    importImage: importImage,
    sendImageFile: sendImageFile
};
