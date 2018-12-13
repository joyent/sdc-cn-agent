/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright (c) 2018, Joyent, Inc.
 */

/*
 * Overview: Workhorse process for migration sync.
 */

var child_process = require('child_process');
var fs = require('fs');
var net = require('net');
var util = require('util');

var assert = require('assert-plus');
var bunyan = require('bunyan');
var once = require('once');
var streamThrottle = require('stream-throttle');
var vasync = require('vasync');

var LineStream = require('lstream');
var smartDcConfig = require('../smartdc-config');


var SERVER_CLOSE_TIMEOUT = 60 * 1000; // 1 minute
var SNAPSHOT_NAME_PREFIX = 'vm-migration-';
var currentProgress = 0;
var stopProcess = false;
var tcpServer;
var totalProgress = 100;
var VERSION = '1.0.0';
var watcher;

/*
 * Setup logging streams.
 */
function setupLogging(action, req_id) {
    var logStreams = [];
    var logfile = util.format('%s/%s-%s-machine_migrate_send.log',
        process.env.logdir, process.env.logtimestamp, process.pid);
    logStreams.push({path: logfile, level: 'debug'});

    // Keep last N log messages around - useful for debugging.
    var ringbuffer = new bunyan.RingBuffer({ limit: 100 });
    logStreams.push({
        level: 'debug',
        type: 'raw',
        stream: ringbuffer
    });

    // Create the logger.
    var log = bunyan.createLogger({
        name: 'migrate-' + action,
        streams: logStreams,
        req_id: req_id
    });

    // Store an easy accessor to the ring buffer.
    log.ringbuffer = ringbuffer;

    return log;
}


// Cribbed from zfs.js
function zfsErrorStr(error, stderr) {
    if (!error) {
        return ('');
    }

    if (error.killed) {
        return ('Process killed due to timeout.');
    }

    return (error.message || (stderr ? stderr.toString() : ''));
}


function zfsError(prefixMsg, error, stderr) {
    var err = (new Error(prefixMsg + ': ' + zfsErrorStr(error, stderr)));
    err.stderr = stderr;
    return err;
}


function writeEvent(socket, event) {
    return socket.write(JSON.stringify(event) + '\n');
}


function endProcess() {
    if (watcher) {
        watcher.end();
    }
    tcpServer.close();
}

function commandStop(opts, event, socket) {
    assert.object(opts, 'opts');
    // assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    opts.log.debug('commandStop');

    stopProcess = true;

    var responseEvent = {
        type: 'response',
        command: event.command,
        eventId: event.eventId
    };
    writeEvent(socket, responseEvent);

    endProcess();
}


function SyncHandler(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.payload, 'opts.payload');
    assert.object(opts.payload.migrationTask, 'opts.payload.migrationTask');
    assert.object(opts.payload.migrationTask.record,
        'opts.payload.migrationTask.record');
    assert.object(opts.payload.vm, 'opts.payload.vm');

    assert.object(event, 'event');
    assert.string(event.host, 'event.host');
    assert.number(event.port, 'event.port');

    this.event = event;
    this.log = opts.log;
    this.opts = opts;
    this.record = opts.payload.migrationTask.record;
    this.socket = socket;
    this.vm = opts.payload.vm;
    this.eventId = 1;
    this.pendingCallbacks = {};

    // This is the main context for each dataset sync operation.
    this.datasets = {};
    this.datasets[this.vm.zfs_filesystem] = {
        zfsFilesystem: this.vm.zfs_filesystem
    };

    // For KVM, the disks hold zfs filesystems that are outside of the base
    // dataset, so we must copy over these filesystems as well. Note that BHYVE
    // uses disks that are a zfs child dataset, which will then be sent
    // recursively all in one go.
    if (this.vm.brand === 'kvm' && Array.isArray(this.vm.disks)) {
        var self = this;

        this.vm.disks.forEach(function _forEachDisk(disk) {
            self.datasets[disk.zfs_filesystem] = {
                zfsFilesystem: disk.zfs_filesystem
            };
        });
    }
}

SyncHandler.prototype.collectSyncInfo =
function _syncHandlerCollectSyncInfo(zfsFilesystemNames, callback) {
    var self = this;

    function collectDatasetInfo(zfsFilesystem, next) {
        var dsCtx = self.datasets[zfsFilesystem];
        dsCtx.endedSuccessfully = false;

        next = once(next);

        // Alternative callback handler for functions outside of the pipeline.
        self.errorCallbackHandler = next;

        vasync.pipeline({arg: dsCtx, funcs: [
            self.getSourceZfsSnapshotNames.bind(self),
            self.connectToReceiver.bind(self),
            self.getTargetZfsSnapshotNames.bind(self),
            self.getZfsSendToken.bind(self),
            self.createMigrationSnapshot.bind(self),
            self.getEstimate.bind(self),
            function _markEndedSuccessfully(ctx, cb) {
                ctx.endedSuccessfully = true;
                cb();
            },
            self.disconnectFromReceiver.bind(self)
        ]}, next);
    }

    vasync.forEachPipeline({
        inputs: zfsFilesystemNames,
        func: collectDatasetInfo
    }, function _collectSyncInfoForEachPipelineCb(err) {
        if (err) {
            callback(err);
            return;
        }

        // Determine total dataset estimated send size.
        totalProgress = zfsFilesystemNames.map(
                function _dsSumMap(zfsFilesystem) {
            return self.datasets[zfsFilesystem].estimatedSize;
        }).reduce(function (a, b) {
            return a + b;
        });

        callback();
    });
};

SyncHandler.prototype.syncDatasets =
function _syncHandlerSyncDatasets(zfsFilesystemNames, callback) {
    var self = this;

    function syncDataset(zfsFilesystem, next) {
        var dsCtx = self.datasets[zfsFilesystem];
        dsCtx.endedSuccessfully = false;

        // Alternative callback handlers for functions outside of the pipeline.
        self.errorCallbackHandler = next;
        self.syncCallbackHandler = next;

        // Do the actual zfs send.
        vasync.pipeline({arg: dsCtx, funcs: [
            self.connectToReceiver.bind(self),
            self.setupSync.bind(self),
            self.startSync.bind(self),
            self.waitForSyncSuccess.bind(self),
            self.disconnectFromReceiver.bind(self)
        ]}, next);
    }

    vasync.forEachPipeline({
        inputs: zfsFilesystemNames,
        func: syncDataset
    }, function _datasetSyncForEachPipelineCb(err) {
        if (err) {
            callback(err);
            return;
        }

        // Re-adjust total progress - as before it was just an estimate.
        totalProgress = currentProgress;
        callback();
    });
};

SyncHandler.prototype.run = function _syncHandlerRun(callback) {
    var self = this;
    var log = self.log;

    // For each dataset, collect and then sync to the target server.
    var zfsFilesystemNames = Object.keys(self.datasets).sort();

    vasync.pipeline({funcs: [
        function collectSyncInfo(ctx, next) {
            self.collectSyncInfo(zfsFilesystemNames, next);
        },
        function syncDatasets(ctx, next) {
            self.syncDatasets(zfsFilesystemNames, next);
        }
    ]}, function _runPipelineCb(err) {
        self.shutdownReceiver(function _shutdownReceiverCb(shutdownErr) {
            if (shutdownErr) {
                log.warn('Error shutting down receiver - ignoring: %s',
                    shutdownErr);
            }
            callback(err);
        });
    });
};

SyncHandler.prototype.shutdownReceiver =
function _syncHandlerShutdownReceiver(callback) {
    var self = this;
    var ctx = {
        endedSuccessfully: true // So no errors get issued during shutdown.
    };

    callback = once(callback);
    self.errorCallbackHandler = callback;

    vasync.pipeline({arg: ctx, funcs: [
        self.connectToReceiver.bind(self),
        self.sendReceiverStop.bind(self),
        self.disconnectFromReceiver.bind(self)
    ]}, callback);
};

SyncHandler.prototype.sendReceiverStop =
function _syncHandlerSendReceiverStop(ctx, callback) {
    var self = this;
    var log = self.log;

    log.debug('sendReceiverStop:: telling target server to stop');

    // Tell the target server we are done - so it can shutdown.
    var command = {
        command: 'stop'
    };
    this.runTargetCommand(ctx.receiverSocket, command,
            function _onStopCb(err, event) {
        if (err) {
            log.warn({event: event}, 'Error telling target to shutdown:', err);
        }
        callback();
    });
};

SyncHandler.prototype.runTargetCommand =
function _syncHandlerRunTargetEvent(socket, event, callback) {
    assert.object(socket, 'socket');
    assert.object(event, 'event');
    assert.func(callback, 'callback');

    event.type = 'request';
    event.eventId = this.eventId;
    this.pendingCallbacks[this.eventId] = callback;
    this.eventId += 1;
    writeEvent(socket, event);
};

SyncHandler.prototype.connectToReceiver =
function _syncHandlerConnectToReceiver(ctx, callback) {
    var self = this;
    var log = self.log;

    var host = self.event.host;
    var port = self.event.port;

    assert.notEqual(host, '', 'host defined');
    assert.notEqual(port, -1, 'port !== -1');

    // 1. Start sync receiver process and socket.
    var sock = new net.Socket({allowHalfOpen: true});
    ctx.receiverSocket = sock;

    sock.setTimeout(5 * 60 * 1000);  // 5 minutes

    log.debug({host: host, port: port},
        'connectToReceiver: connecting to cn-agent target process');

    sock.on('error', function _onSocketError(err) {
        log.warn('connectToReceiver: socket error:', err);
        sock.destroy();
        self.errorCallbackHandler(err);
    });

    sock.on('timeout', function _onSocketTimeout() {
        log.warn('connectToReceiver: socket timeout');
        sock.destroy();
        self.errorCallbackHandler(new Error('receiver socket timeout'));
    });

    sock.on('end', function _onSockEnd() {
        if (!ctx.endedSuccessfully) {
            log.warn('startZfsReceiver: sock ended without "sync-success"');
            sock.destroy();
            self.errorCallbackHandler(new Error(
                'No "sync-success" received from target cn-agent process'));
            return;
        }

        log.info('startZfsReceiver: sock ended successfully');
    });

    function onSockConnect() {
        log.debug(
            'connectToReceiver: connected to the cn-agent target process');

        var responseStream = new LineStream();

        responseStream.on('readable', function _commandStreamReadableCb() {
            var line = this.read();
            while (line) {
                processResponse(line);
                line = this.read();
            }
        });

        function processResponse(line) {
            var event;

            try {
                event = JSON.parse(line);
            } catch (ex) {
                log.warn('Ignoring bad JSON line:', line);
                return;
            }

            assert.string(event.type, 'event.type');

            // Handle errors with a specific handler.
            if (event.type === 'error') {
                assert.func(self.errorCallbackHandler,
                    'self.errorCallbackHandler');

                log.error({event: event},
                    'received "error" event from target cn-agent process');
                self.errorCallbackHandler(new Error(event.message), event);
                return;
            }

            // Handle sync success command.
            if (event.type === 'sync-success') {
                assert.func(self.syncCallbackHandler,
                    'self.syncCallbackHandler');

                // Mark that the sync was successful.
                ctx.endedSuccessfully = true;

                log.info({event: event},
                    'received success event from target cn-agent process');
                self.syncCallbackHandler(null, event);
                return;
            }

            // Other events should be in response to a specific request,
            // which must have their own specific callback handler.
            assert.number(event.eventId, 'event.eventId');
            assert.equal(event.type, 'response');
            assert.func(self.pendingCallbacks[event.eventId],
                'self.pendingCallbacks[event.eventId]');

            var cb = self.pendingCallbacks[event.eventId];
            cb(null, event);
        }

        sock.pipe(responseStream);

        callback();
    }

    sock.connect({host: host, port: port}, onSockConnect);
};

SyncHandler.prototype.getSourceZfsSnapshotNames =
function _syncHandlerGetSourceZfsSnapshotNames(ctx, callback) {
    var log = this.log;

    var cmd = '/usr/sbin/zfs';
    var args = [
        'list',
        '-t',
        'snapshot',
        '-r',
        '-H',
        '-o',
        'name',
        ctx.zfsFilesystem
    ];

    log.debug({cmd: cmd, args: args}, 'getSourceZfsSnapshotNames');

    child_process.execFile(cmd, args, function (err, stdout, stderr) {
        if (err) {
            log.error({cmd: cmd, args: args},
                'Error listing dataset snapshots, err: %s, stderr: %s',
                err, stderr);
            callback(err);
            return;
        }

        // Example output:
        //   zones/9367e1db-c624-4aab-b91c-a920acaaaaaa@vm-migration-1
        //   zones/9367e1db-c624-4aab-b91c-a920acaaaaaa@vm-migration-2

        var lines = String(stdout).trim().split('\n');
        ctx.sourceSnapshotNames = lines.map(function _lineMap(line) {
            return line.split('@').splice(-1)[0];
        }).filter(function _nameFilter(name) {
            return name.startsWith(SNAPSHOT_NAME_PREFIX);
        }).sort(function (a, b) {
            return Number(a.substr(SNAPSHOT_NAME_PREFIX.length)) -
                Number(b.substr(SNAPSHOT_NAME_PREFIX.length));
        });

        callback();
    });
};

/**
 * The target vm uuid may be different to the source - if it is different then
 * the zfs filesystem name will also be different - so handle that here.
 */
SyncHandler.prototype.convertTargetZfsFilesystem =
function _syncHandlerConvertTargetZfsFilesystem(zfsFilesystem) {
    if (this.record.vm_uuid !== this.record.target_vm_uuid) {
        return zfsFilesystem.replace(this.record.vm_uuid,
            this.record.target_vm_uuid);
    }

    return zfsFilesystem;
};

SyncHandler.prototype.getTargetZfsSnapshotNames =
function _syncHandlerGetTargetZfsSnapshotNames(ctx, callback) {
    var log = this.log;

    log.debug('getTargetZfsSnapshotNames:: asking target for snapshot names');

    // Get the zfs migration snapshot names from the target server.
    var command = {
        command: 'get-zfs-snapshot-names',
        zfsFilesystem: this.convertTargetZfsFilesystem(ctx.zfsFilesystem)
    };
    this.runTargetCommand(ctx.receiverSocket, command,
            function _getTokenCb(err, event) {
        if (err) {
            callback(err);
            return;
        }

        log.info({names: event.names},
            'getTargetZfsSnapshotNames:: got response');
        ctx.targetSnapshotNames = event.names;

        if (!Array.isArray(ctx.targetSnapshotNames)) {
            log.warn('getTargetZfsSnapshotNames:: not an array!?');
            ctx.targetSnapshotNames = [];
        }

        callback();
    });
};

SyncHandler.prototype.getZfsSendToken =
function _syncHandlerGetZfsSendToken(ctx, callback) {
    var log = this.log;
    var record = this.record;

    assert.arrayOfObject(record.progress_history,
        'record.progress_history');

    var syncProgressEvents = record.progress_history.filter(
        function _firstSync(p) {
            return p.phase === 'sync' && p.state !== 'warning';
        });

    // If there is more than one 'sync' progress entry record, then
    // we've previously done (or at least tried to do) a sync
    // operation before. Note that there must be at least one sync
    // progress event - for the current sync operation.
    ctx.isFirstSync = (syncProgressEvents.length === 1);
    ctx.continueLastSync = false;

    if (ctx.isFirstSync) {
        callback();
        return;
    }

    assert.ok(syncProgressEvents.length > 1,
        'syncProgressEvents.length > 1');

    var previousSync = syncProgressEvents.slice(-2)[0];
    if (previousSync.state !== 'success') {
        ctx.continueLastSync = true;
    }

    if (!ctx.continueLastSync) {
        callback();
        return;
    }

    log.debug('getZfsSendToken:: asking target for sync token');

    // Get the zfs send token from the target server.
    var command = {
        command: 'get-zfs-resume-token',
        zfsFilesystem: this.convertTargetZfsFilesystem(ctx.zfsFilesystem)
    };
    this.runTargetCommand(ctx.receiverSocket, command,
            function _getTokenCb(err, event) {
        if (err) {
            callback(err);
            return;
        }

        log.info({token: event.token}, 'getZfsSendToken:: got token response');
        ctx.token = event.token;

        if (!ctx.token) {
            ctx.continueLastSync = false;
            if (ctx.targetSnapshotNames.length === 0) {
                ctx.isFirstSync = true;
            }
        }

        callback();
    });
};

SyncHandler.prototype.createMigrationSnapshot =
function _syncHandleCreateMigrationSnapshot(ctx, callback) {
    var log = this.log;
    var record = this.record;

    if (ctx.continueLastSync) {
        log.info({zfsFilesystem: ctx.zfsFilesystem},
            'createMigrationSnapshot:: ignoring - continueLastSync set');
        callback();
        return;
    }

    ctx.prevSnapshotName = SNAPSHOT_NAME_PREFIX + record.num_sync_phases;
    ctx.snapshotName = SNAPSHOT_NAME_PREFIX + (record.num_sync_phases + 1);

    while (ctx.targetSnapshotNames.lastIndexOf(ctx.snapshotName) >= 0) {
        log.warn({zfsFilesystem: ctx.zfsFilesystem,
            snapshotName: ctx.snapshotName},
            'Snapshot name already exists remotely - use next available name');
        record.num_sync_phases += 1;
        ctx.prevSnapshotName = SNAPSHOT_NAME_PREFIX + record.num_sync_phases;
        ctx.snapshotName = SNAPSHOT_NAME_PREFIX + (record.num_sync_phases + 1);
        // When a vm-migration snapshot exists remotely, then we must have
        // successfully performed at least one sync operation!
        ctx.isFirstSync = false;
    }

    // Check if the source snapshot already exists.
    if (ctx.sourceSnapshotNames.indexOf(ctx.snapshotName) >= 0) {
        log.info({snapshotName: ctx.snapshotName}, 'Snapshot already exists');
        callback();
        return;
    }

    var cmd = '/usr/sbin/zfs';
    var args = [
        'snapshot',
        '-r',
        util.format('%s@%s', ctx.zfsFilesystem, ctx.snapshotName)
    ];
    var timeout = 15 * 60 * 1000; // 15 minutes

    log.info({cmd: cmd, args: args, timeout: timeout},
        'createMigrationSnapshot');

    child_process.execFile(cmd, args, { timeout: timeout},
            function (error, stdout, stderr) {
        if (error) {
            log.error('zfs snapshot error:', error, ', stderr:', stderr);
            callback(zfsError('zfs snapshot error', error, stderr));
            return;
        }

        callback();
    });
};

SyncHandler.prototype.getZfsSyncArgs =
function _syncHandleGetZfsSyncArgs(ctx) {
    if (ctx.continueLastSync) {
        assert.string(ctx.token, 'ctx.token');

        return [
            'send',
            '-t',
            ctx.token
        ];
    }

    if (ctx.isFirstSync) {
        assert.string(ctx.snapshotName, 'ctx.snapshotName');
        assert.string(ctx.zfsFilesystem, 'ctx.zfsFilesystem');

        return [
            'send',
            '--replicate',
            util.format('%s@%s', ctx.zfsFilesystem, ctx.snapshotName)
        ];
    }

    assert.string(ctx.snapshotName, 'ctx.snapshotName');
    assert.string(ctx.prevSnapshotName, 'ctx.prevSnapshotName');
    assert.string(ctx.zfsFilesystem, 'ctx.zfsFilesystem');

    return [
        'send',
        '-I',
        util.format('%s@%s', ctx.zfsFilesystem, ctx.prevSnapshotName),
        util.format('%s@%s', ctx.zfsFilesystem, ctx.snapshotName)
    ];
};

SyncHandler.prototype.getEstimate =
function _syncHandleGetEstimate(ctx, callback) {
    var log = this.log;

    var cmd = '/usr/sbin/zfs';
    var args = this.getZfsSyncArgs(ctx);
    var timeout = 5 * 60 * 1000; // 5 minutes

    assert.equal(args[0], 'send');

    args.splice(1, 0, '--parsable', '--dryrun');

    log.info({cmd: cmd, args: args, timeout: timeout},
        'createMigrationSnapshot');

    child_process.execFile(cmd, args, { timeout: timeout},
            function (error, stdout, stderr) {
        if (error) {
            log.error('zfs snapshot error:', error, ', stderr:', stderr);
            callback(zfsError('zfs snapshot error', error, stderr));
            return;
        }

        var lastLine = stdout.trim().split('\n').splice(-1)[0].trim();
        log.trace('getEstimate:: lastLine: %s', lastLine);

        var match = lastLine.match(/^size\s+(\d+)$/);
        if (!match) {
            log.error('Unable to get zfs send estimate from stdout:', stdout);
            callback(new Error('Unable to get zfs send estimate'));
            return;
        }

        ctx.estimatedSize = Number(match[1]);
        log.debug({zfsFilesystem: ctx.zfsFilesystem,
            estimatedSize: ctx.estimatedSize},
            'getEstimate');

        callback();
    });
};

SyncHandler.prototype.setupSync = function _syncHandleSetupSync(ctx, callback) {
    this.log.info('setupSync');
    // This will start the zfs receive on the target.
    var isFirstSync = ctx.isFirstSync && !ctx.continueLastSync;
    var command = {
        command: 'sync',
        isFirstSync: isFirstSync,
        zfsFilesystem: this.convertTargetZfsFilesystem(ctx.zfsFilesystem)
    };
    this.runTargetCommand(ctx.receiverSocket, command, callback);
};

SyncHandler.prototype.startSync = function _syncHandleRunSync(ctx, callback) {
    var self = this;
    var log = self.log;

    // Run zfs sync and pipe data through to the target cn-agent socket, which
    // feeds the data into the zfs receive process on the target.
    var cmd = '/usr/sbin/zfs';
    var args = this.getZfsSyncArgs(ctx);
    var progressIntervalId = -1;
    var startingBytes = ctx.receiverSocket.bytesWritten;
    var stderr;

    log.debug({cmd: cmd, args: args}, 'startSync:: zfs send command');

    var zfsSend = child_process.spawn(cmd, args,
        {
            detached: true,
            stdio: [ 'ignore', 'pipe', 'pipe']
        });

    zfsSend.on('error', function (err) {
        log.error({
                exitCode: zfsSend.exitCode,
                killed: zfsSend.killed,
                signalCode: zfsSend.signalCode
            }, 'zfs send error:', err, ', stderr:', stderr);

        // Adjust the progress made and end the progress updater.
        currentProgress = ctx.receiverSocket.bytesWritten - startingBytes;
        clearInterval(progressIntervalId);
        progressIntervalId = -1;

        self.errorCallbackHandler(err);
    });

    zfsSend.on('close', function (code) {
        log.info({
                exitCode: zfsSend.exitCode,
                killed: zfsSend.killed,
                signalCode: zfsSend.signalCode
            },
            'zfs send closed, stderr:\n', stderr);

        // Adjust the progress made and end the progress updater.
        currentProgress = ctx.receiverSocket.bytesWritten - startingBytes;
        clearInterval(progressIntervalId);
        progressIntervalId = -1;

        if (zfsSend.killed) {
            self.errorCallbackHandler(new Error('zfs send process was killed'));
            return;
        }

        if (code) {
            self.errorCallbackHandler(new Error(
                'zfs send exited with code: ' + code));
            return;
        }

        log.debug('startSync: zfs send finished successfully');
    });

    zfsSend.stderr.on('data', function (buf) {
        log.warn('zfs send stderr: ' + String(buf));
        // Only keep the first 2500 and last 2500 characters of stderr.
        if (stderr) {
            stderr = Buffer.concat([stderr, buf]);
        } else {
            stderr = buf;
        }
        if (stderr.length > 5000) {
            stderr = Buffer.concat([
                stderr.slice(0, 2500),
                Buffer.from('\n...\n'),
                stderr.slice(-2500)
            ]);
        }
    });

    // XXX: TODO: Rate should come from inputs.
    var rate;
    // rate = 1 * 1024 * 1024; // 1 MB/sec
    // rate = 1 * 128 * 1024; // 128 KB/sec

    // Limit how much "zfs send" data we send through the socket.
    if (rate) {
        self.throttle = new streamThrottle.Throttle({rate: rate});
        zfsSend.stdout.pipe(self.throttle).pipe(ctx.receiverSocket);
    } else {
        zfsSend.stdout.pipe(ctx.receiverSocket);
    }

    // Periodically update the progress made.
    progressIntervalId = setInterval(function _onUpdateProgress() {
        if (stopProcess) {
            log.info('Progress updater stopped because stopProcess is set');
            clearInterval(progressIntervalId);
            progressIntervalId = -1;
            return;
        }
        currentProgress = ctx.receiverSocket.bytesWritten - startingBytes;
        if (currentProgress > totalProgress) {
            totalProgress = currentProgress;
        }
    }, 495);

    // self.zfsSendProcess = zfsSend;

    callback();
};


SyncHandler.prototype.waitForSyncSuccess =
function _syncHandleWaitForSyncSuccess(ctx, callback) {
    this.log.info('waiting for sync success event');

    // Override the callback handler to be the given callback. This will be
    // fired when the 'sync-success' event is seen (or there is an error).
    if (!stopProcess) {
        this.syncCallbackHandler = once(callback);
    }
};

SyncHandler.prototype.disconnectFromReceiver =
function _syncHandleDisconnectFromReceiver(ctx, callback) {
    assert.object(ctx.receiverSocket, 'ctx.receiverSocket');

    ctx.receiverSocket.end();
    callback();
};

function commandSync(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(socket, 'socket');

    var log = opts.log;

    log.debug({event: event}, 'commandSync');

    if (!watcher) {
        watcher = new Watcher(opts);
    }
    watcher.addSocket(socket);

    var sync = new SyncHandler(opts, event, socket);

    sync.run(function _onSyncInstRunCb(err, details) {
        var responseEvent;
        if (err) {
            log.error({err: err}, 'commandSync failed - ending source process');
            responseEvent = {
                type: 'error',
                command: event.command,
                details: details,
                err: err,
                eventId: event.eventId,
                message: 'sync error: ' + err.message
            };
            if (!socket.destroyed) {
                writeEvent(socket, responseEvent);
            }
            endProcess();
            return;
        }

        log.info('sync command finished successfully');
        responseEvent = {
            type: 'response',
            command: event.command,
            details: details,
            eventId: event.eventId
        };
        writeEvent(socket, responseEvent);
    });
}

function Watcher(opts) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(opts.payload, 'opts.payload');
    assert.object(opts.payload.migrationTask, 'opts.payload.migrationTask');
    assert.object(opts.payload.migrationTask.record,
        'opts.payload.migrationTask.record');
    assert.uuid(opts.payload.migrationTask.record.vm_uuid,
        'opts.payload.migrationTask.record.vm_uuid');

    this.log = opts.log;
    this.isRunning = false;
    this.lastProgress = -1;
    this.runTimeoutId = -1;
    this.sockets = [];
    this.vm_uuid = opts.payload.migrationTask.record.vm_uuid;
}

Watcher.prototype.addSocket = function WatcherAdd(socket) {
    var self = this;

    if (self.sockets.indexOf(socket) !== -1) {
        // Socket is already added - nothing to do.
        return;
    }

    self.sockets.push(socket);

    socket.once('error', function _onSocketWatchError(err) {
        self.log.warn('Watcher:: socket error: ', err);
    });

    socket.once('close', function _onSocketWatchClose() {
        if (stopProcess || !self.isRunning) {
            // Do not fight with the end calls.
            return;
        }
        var idx = self.sockets.indexOf(socket);
        if (idx >= 0) {
            self.sockets.splice(idx, 1);
            self.log.info({numSockets: self.sockets.length},
                'Watcher:: socket close event received - removed');
        } else {
            self.log.error({socket: socket},
                'Watcher:: should not get a close event for an unknown socket');
        }
    });

    self.log.info({numSockets: self.sockets.length},
        'Watcher:: added watcher socket');

    self.run();
};

Watcher.prototype.run = function WatcherRun() {
    var self = this;

    if (self.isRunning) {
        return;
    }

    self.isRunning = true;

    var loopCount = 0;

    // Send progress events every second (if progress was made), or at least
    // once every 60 seconds (the latter is used as a socket keep alive).
    function runLoop() {
        if (stopProcess) {
            self.log.info('Watcher:: stopped because stopProcess is set');
            return;
        }
        if (!self.isRunning) {
            self.log.info('Watcher:: stopped');
            return;
        }

        loopCount += 1;

        if (loopCount === 60) {
            loopCount = 0;
            self.sendProgress(true);
        } else {
            self.sendProgress(false);
        }

        self.runTimeoutId = setTimeout(runLoop, 1000);
    }

    runLoop();

    self.log.info('Watcher:: started');
};


Watcher.prototype.destroySockets = function WatcherDestroySockets() {
    this.log.debug({numSockets: this.sockets.length},
        'Watcher:: closing watcher sockets');
    this.sockets.forEach(function _endForEachSocket(socket) {
        socket.destroy();
    });
    this.sockets = [];
};

Watcher.prototype.end = function WatcherEnd() {
    this.log.info('Watcher:: end');
    this.isRunning = false;

    clearTimeout(this.runTimeoutId);

    this.destroySockets();
};

Watcher.prototype.sendProgress = function WatcherSendProgress(isMinute) {
    // Send progress events when there has been progress made, or when there
    // has been no progress for a minute (just to keep the sockets alive).
    var progressMade = currentProgress !== this.lastProgress;

    if (isMinute || progressMade) {
        // Send a progress event.
        var event = {
            current_progress: currentProgress,
            phase: 'sync',
            state: 'running',
            store: isMinute,
            total_progress: totalProgress,
            type: 'progress'
        };
        this.lastProgress = currentProgress;
        this.sendEvent(event);
        this.log.trace({
                progressMade: progressMade,
                currentProgress: currentProgress,
                totalProgress: totalProgress
            }, 'Watcher:: sent progress event');
    }
};

Watcher.prototype.sendEvent = function WatcherSendEvent(event) {
    var line = JSON.stringify(event) + '\n';

    this.sockets.forEach(function _sendEventForEachSocket(socket) {
        socket.write(line);
    });
};


function commandWatch(opts, event, socket) {
    assert.object(opts, 'opts');
    // assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    if (!watcher) {
        watcher = new Watcher(opts);
    }
    watcher.addSocket(socket);
}


function commandSetRecord(opts, event, socket) {
    assert.object(opts, 'opts');
    // assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.object(event.record, 'event.record');
    assert.object(socket, 'socket');

    opts.log.debug({record: event.record}, 'commandSetRecord');

    // Update the migration record.
    opts.payload.migrationTask.record = event.record;

    var responseEvent = {
        type: 'response',
        command: event.command,
        eventId: event.eventId
    };
    writeEvent(socket, responseEvent);
}


function commandPing(opts, event, socket) {
    assert.object(opts, 'opts');
    // assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    opts.log.debug('commandPing');

    var responseEvent = {
        type: 'response',
        command: event.command,
        eventId: event.eventId,
        pid: process.pid,
        version: VERSION
    };
    writeEvent(socket, responseEvent);
}


function commandNotImplemented(opts, event, socket) {
    assert.object(opts, 'opts');
    // assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    opts.log.debug({event: event}, 'commandNotImplemented');

    var responseEvent = {
        type: 'error',
        command: event.command,
        eventId: event.eventId,
        message: 'Not Implemented',
        version: VERSION
    };

    writeEvent(socket, responseEvent);
}


function onSocketCommand(opts, socket, line) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(socket, 'socket');
    assert.string(line, 'line');

    var event;
    var log = opts.log;

    log.debug('received command line: %j', line);

    try {
        event = JSON.parse(line);
    } catch (e) {
        log.error('Build: invalid json: %s - ignoring', line);
        return;
    }

    assert.equal(event.type, 'request');

    switch (event.command) {
        case 'end':
            commandStop(opts, event, socket);
            break;
        case 'stop':
            commandStop(opts, event, socket);
            break;
        case 'ping':
            commandPing(opts, event, socket);
            break;
        case 'set-record':
            commandSetRecord(opts, event, socket);
            break;
        case 'sync':
            commandSync(opts, event, socket);
            break;
        case 'watch':
            commandWatch(opts, event, socket);
            break;
        // case 'abort':
        // case 'pause':
        default:
            log.error('Unhandled socket event - ignoring: %j', event);
            break;
    }
}


function handleSocketConnection(opts, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(socket, 'socket');

    var log = opts.log;

    log.info('got connection from', socket.address());

    socket.on('error', function _onSocketError(err) {
        log.warn('handleSocketConnection: socket.error', err);
    });

    socket.on('end', function _onSocketEnd() {
        log.debug('handleSocketConnection: socket.end received');
    });

    // Read what the socket wants us to do.
    var commandStream = new LineStream();
    socket.pipe(commandStream);

    commandStream.on('readable', function _commandStreamReadableCb() {
        var line = this.read();
        while (line) {
            onSocketCommand(opts, socket, line);
            line = this.read();
        }
    });
}


/**
 * Setup the tcp server and send back the process/server details.
 */
function setupMigrationSocket(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.func(callback, 'callback');

    var log = opts.log;

    log.debug({payload: opts.payload}, 'migration payload');

    var onListening = function migrate_socket_onListening() {
        var addr = tcpServer.address();
        var response = {
            event: 'setup completed',
            host: opts.adminIp,
            pid: process.pid,
            port: addr.port
        };

        log.info('MigrationTask listening on socket %j', addr);

        callback(null, response);
    };

    log.info('MigrationTask setting up socket');

    /**
     * Create TCP Server which will output the build stream.
     */
    tcpServer = net.createServer({ allowHalfOpen: true });

    tcpServer.on('connection', function _onConnection(socket) {
        handleSocketConnection(opts, socket);
    });

    tcpServer.listen(0, opts.adminIp, onListening);
}


/*
 * Main entry point.
 */
process.on('message', function (message) {
    assert.object(message, 'message');
    assert.object(message.payload, 'payload');
    assert.object(message.payload.migrationTask, 'payload.migrationTask');
    assert.string(message.payload.migrationTask.action,
        'payload.migrationTask.action');
    assert.string(message.req_id, 'req_id');
    assert.optionalNumber(message.timeoutSeconds, 'timeoutSeconds');
    assert.string(message.uuid, 'uuid');

    var action = message.payload.migrationTask.action;  // 'sync' or 'switch'.
    assert.ok(action === 'sync' || action === 'switch',
        'Unknown action: ' + action);

    var log = setupLogging(action, message.req_id);

    var opts = {
        log: log,
        req_id: message.req_id,
        payload: message.payload,
        uuid: message.uuid,
        timeoutSeconds: message.timeoutSeconds || SERVER_CLOSE_TIMEOUT
    };

    // This process will listen on the admin network, allowing a connection
    // from vmapi/workflow to control the process actions.
    smartDcConfig.getFirstAdminIp(function (aerr, adminIp) {
        if (aerr) {
            process.send({error: { message: aerr.message, aerr: aerr.stack }});
            return;
        }

        opts.adminIp = adminIp;

        setupMigrationSocket(opts, function (err, response) {
            if (err) {
                process.send({error: { message: err.message, err: err.stack }});
                return;
            }

            process.send(response);
        });
    });
});