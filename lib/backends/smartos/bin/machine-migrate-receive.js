/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

/*
 * Overview: Receiver process for migrating an instance.
 */

var child_process = require('child_process');
var net = require('net');
var util = require('util');

var assert = require('assert-plus');
var bunyan = require('bunyan');

var LineStream = require('lstream');
var smartDcConfig = require('../smartdc-config');


var SERVER_CLOSE_TIMEOUT = 60 * 1000; // 1 minute
var SNAPSHOT_NAME_PREFIX = 'vm-migration-';
var gLog;
var tcpServer;
var VERSION = '1.0.0';

var gExecFileDefaults = {
    // The default maxBuffer for child_process.execFile is 200Kb, we use a much
    // larger value in our execFile calls.
    maxBuffer: 50 * 1024 * 1024
};

/*
 * Setup logging streams.
 */
function setupLogging(req_id) {
    var logStreams = [];
    var logfile = util.format('%s/%s-%s-migrate_machine_receive.log',
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
        name: 'migrate-receive',
        streams: logStreams,
        req_id: req_id
    });

    // Store an easy accessor to the ring buffer.
    log.ringbuffer = ringbuffer;

    gLog = log;

    return log;
}


function writeEvent(socket, event) {
    if (socket.destroyed) {
        gLog.warn({event: event}, 'writeEvent:: socket already destroyed');
        return;
    }
    gLog.debug({event: event}, 'write event');
    socket.write(JSON.stringify(event) + '\n');
}


function endServer() {
    tcpServer.close();
    gLog.info('endServer');
}


function endProcess(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    endServer();

    var responseEvent = {
        type: 'response',
        command: event.command,
        eventId: event.eventId
    };

    writeEvent(socket, responseEvent);
    socket.destroy();
}


function commandStop(opts, event, socket) {
    assert.object(opts, 'opts');
    // assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    opts.log.info('commandStop');

    endProcess(opts, event, socket);
}


// Note: From this point on - anything received on this socket will be zfs send
// data.
function zfsSyncReceive(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.commandStream, 'opts.commandStream');
    assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.string(event.zfsFilesystem, 'event.zfsFilesystem');
    assert.object(socket, 'socket');

    var cmd = '/usr/sbin/zfs';
    var args = [
        'receive',
        '-u', // Do not mount the filesystem after receiving.
        '-s', // If receive is interrupted, save the partially received state.
        '-F', // Rollback to the most recent snapshot before running receive.
              // Brings in any new snapshot names from the source.
        // Omit the "encryption" property to allow migrating from an
        // unencrypted CN to an encrypted CN
        // This avoids the following error on the receiving end:
        // "zfs receive exited with code: 1 (cannot receive new filesystem
        // stream: parent 'zones' must not be encrypted to receive unenecrypted
        // property)"
        '-x', 'encryption',
        event.zfsFilesystem
    ];
    var log = opts.log;
    var output = {
        stdout: null,
        stderr: null
    };
    var responseEvent;

    // Disconnect the line stream reader.
    socket.unpipe(opts.commandStream);

    log.debug('zfsSyncReceive:: unpiped command stream');

    log.debug({cmd: cmd, args: args}, 'zfsSyncReceive');

    var zfsReceive = child_process.spawn(cmd, args,
        {
            detached: true,
            stdio: ['pipe', 'pipe', 'pipe']
        });

    zfsReceive.on('error', function (err) {
        log.error({
                exitCode: zfsReceive.exitCode,
                killed: zfsReceive.killed,
                signalCode: zfsReceive.signalCode
            },
            'zfs receive error: %s, stderr: %s', err, String(output.stderr));

        endServer();

        responseEvent = {
            type: 'error',
            command: event.command,
            eventId: event.eventId,
            message: 'zfs receive process error: ' + err,
            err: err,
            stderr: String(output.stderr)
        };
        writeEvent(socket, responseEvent);
    });

    zfsReceive.on('close', function (code) {
        log.info({
                exitCode: zfsReceive.exitCode,
                killed: zfsReceive.killed,
                signalCode: zfsReceive.signalCode
            },
            'zfs receive closed with code: %s, stdout: %s\nstderr: %s\n',
            code, String(output.stdout), String(output.stderr));

        if (zfsReceive.killed) {
            responseEvent = {
                type: 'error',
                command: event.command,
                eventId: event.eventId,
                message: 'zfs receive process was killed',
                stderr: String(output.stderr)
            };
            writeEvent(socket, responseEvent);
            return;
        }

        if (code !== 0) {
            responseEvent = {
                type: 'error',
                command: event.command,
                eventId: event.eventId,
                message: 'zfs receive exited with code: ' + code,
                stderr: String(output.stderr)
            };
            writeEvent(socket, responseEvent);
            return;
        }

        responseEvent = {
            type: 'sync-success'
        };
        writeEvent(socket, responseEvent);
    });

    function storeLimitedOutput(type, buf) {
        // Only keep the first 2500 and last 2500 characters of stdout.
        if (output[type]) {
            output[type] = Buffer.concat([output[type], buf]);
        } else {
            output[type] = buf;
        }
        if (output[type].length > 5000) {
            output[type] = Buffer.concat([
                output[type].slice(0, 2500),
                Buffer.from('\n...\n'),
                output[type].slice(-2500)
            ]);
        }
    }

    zfsReceive.stdout.on('data', function (buf) {
        log.debug('zfsSyncReceive:: zfs receive stdout: ' + String(buf));
        storeLimitedOutput('stdout', buf);
    });

    zfsReceive.stderr.on('data', function (buf) {
        log.info('zfsSyncReceive:: zfs receive stderr: ' + String(buf));
        storeLimitedOutput('stderr', buf);
    });

    // Must catch EPIPE errors here to avoid crashing the process.
    zfsReceive.stdin.on('error', function _handleZfsStdinError(err) {
        log.info('zfsSyncReceive:: zfs stdin err: %s', err);
    });

    // All future socket data will be piped into zfs receive.
    socket.pipe(zfsReceive.stdin);

    // Inform the source process that we are all ready to go.
    responseEvent = {
        type: 'response',
        command: event.command,
        eventId: event.eventId
    };
    writeEvent(socket, responseEvent);
}


function destroyDataset(dataset, log, callback) {
    var cmd = '/usr/sbin/zfs';
    var args = [
        'destroy',
        '-f',
        '-r',
        dataset
    ];

    log.debug({cmd: cmd, args: args}, 'destroyDataset');

    child_process.execFile(cmd, args, gExecFileDefaults,
            function _execZfsDestroyCb(error, stdout, stderr) {
        if (error) {
            log.error('zfs destroy error:', error,
                ', stderr:', String(stderr));
            callback(new Error('zfs destroy error: ' + error));
            return;
        }

        callback();
    });
}

function commandZfsDestroy(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.string(event.zfsFilesystem, 'event.zfsFilesystem');
    assert.object(socket, 'socket');

    var log = opts.log;
    var responseEvent;

    destroyDataset(event.zfsFilesystem, log, function _zfsDestroyCb(err) {
        if (err && (!err.message || err.message.indexOf(
                'could not find any snapshots to destroy') === -1)) {
            responseEvent = {
                type: 'error',
                command: event.command,
                eventId: event.eventId,
                err: err,
                message: err.message
            };
            writeEvent(socket, responseEvent);
            return;
        }

        // Destroy was successful - send response.
        responseEvent = {
            type: 'response',
            command: event.command,
            eventId: event.eventId
        };

        writeEvent(socket, responseEvent);
    });
}

function commandSync(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.bool(event.isFirstSync, 'event.isFirstSync');
    assert.bool(event.resumeSync, 'event.resumeSync');
    assert.string(event.zfsFilesystem, 'event.zfsFilesystem');
    assert.object(socket, 'socket');

    // If this is the first sync (and it's not a resume) destroy the existing
    // zfs filesystem (as the filesystem will be sent over afresh).

    if (!event.isFirstSync || event.resumeSync) {
        zfsSyncReceive(opts, event, socket);
        return;
    }

    var log = opts.log;
    var responseEvent;

    var cmd = '/usr/sbin/zfs';
    var args = [
        'list',
        event.zfsFilesystem
    ];

    log.debug({cmd: cmd, args: args},
        'commandSync:: checking if dataset exists');

    child_process.execFile(cmd, args, gExecFileDefaults,
            function _execZfsListCb(error, stdout, stderr) {
        if (error) {
            // Allow a "dataset does not exist" error.
            if (stderr && stderr.indexOf('dataset does not exist') >= 0) {
                log.info('commandSync:: zfs dataset does not exist');
                zfsSyncReceive(opts, event, socket);
                return;
            }

            responseEvent = {
                type: 'error',
                command: event.command,
                eventId: event.eventId,
                message: 'zfs list error: ' + error
            };

            writeEvent(socket, responseEvent);
            return;
        }

        destroyDataset(event.zfsFilesystem, log, function _destroyDsCb(err) {
            if (err) {
                log.error('zfs destroy error:', err,
                    ', stderr:', String(stderr));

                responseEvent = {
                    type: 'error',
                    command: event.command,
                    eventId: event.eventId,
                    message: 'zfs destroy error: ' + err
                };
                writeEvent(socket, responseEvent);
                return;
            }

            // Destroy was successful - now go and sync.
            zfsSyncReceive(opts, event, socket);
        });
    });
}


/**
 * Retrieve the zfs resume token for the provided dataset.
 */
function commandGetZfsResumeToken(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.string(event.zfsFilesystem, 'event.zfsFilesystem');
    assert.object(socket, 'socket');

    var log = opts.log;
    var responseEvent;

    // Check if the dataset exists.
    function checkThenGetToken() {
        var cmd = '/usr/sbin/zfs';
        var args = [
            'list',
            event.zfsFilesystem
        ];

        log.debug({cmd: cmd, args: args}, 'commandGetZfsResumeToken');

        child_process.execFile(cmd, args, gExecFileDefaults,
                function _execZfsListResumeCb(error, stdout, stderr) {
            if (error) {
                // Allow a "dataset does not exist" error.
                if (stderr && stderr.indexOf('dataset does not exist') >= 0) {
                    log.info('zfs dataset does not exist');
                    responseEvent = {
                        type: 'response',
                        command: event.command,
                        eventId: event.eventId
                    };

                    writeEvent(socket, responseEvent);
                    return;
                }

                responseEvent = {
                    type: 'error',
                    command: event.command,
                    eventId: event.eventId,
                    message: 'zfs list error: ' + error
                };

                writeEvent(socket, responseEvent);
                return;
            }

            getToken();
        });
    }

    function getToken() {
        var cmd = '/usr/sbin/zfs';
        var args = [
            'get',
            '-Ho',
            'value',
            'receive_resume_token',
            event.zfsFilesystem
        ];

        log.debug({cmd: cmd, args: args}, 'commandGetZfsResumeToken');

        child_process.execFile(cmd, args, gExecFileDefaults,
                function _execZfsGetResumeToken(error, stdout, stderr) {
            if (error) {
                log.error('zfs get error:', error, ', stderr:', String(stderr));

                responseEvent = {
                    type: 'error',
                    command: event.command,
                    eventId: event.eventId,
                    message: 'zfs get error: ' + error
                };
                writeEvent(socket, responseEvent);
                return;
            }

            var token = String(stdout).trim();

            log.debug({token: token}, 'commandGetZfsResumeToken:: got token');

            // A dash means there is no resume token.
            if (token === '-') {
                token = '';
            }

            responseEvent = {
                type: 'response',
                command: event.command,
                eventId: event.eventId,
                token: token
            };

            writeEvent(socket, responseEvent);
        });
    }

    checkThenGetToken();
}


/**
 * Retrieve the zfs snapshot names for the provided dataset.
 */
function commandGetZfsSnapshotNames(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.string(event.zfsFilesystem, 'event.zfsFilesystem');
    assert.object(socket, 'socket');

    var log = opts.log;
    var responseEvent;

    var cmd = '/usr/sbin/zfs';
    var args = [
        'list',
        '-t',
        'snapshot',
        '-r',
        '-H',
        '-s',
        'creation', // Sort by creation time (oldest snapshot first).
        '-o',
        'name',
        event.zfsFilesystem
    ];

    log.debug({cmd: cmd, args: args}, 'commandGetZfsSnapshotNames');

    child_process.execFile(cmd, args, gExecFileDefaults,
            function _execZfsListSnapshots(error, stdout, stderr) {
        if (error) {
            // Allow a "dataset does not exist" error.
            if (stderr && stderr.indexOf('dataset does not exist') >= 0) {
                log.info('zfs dataset does not exist');
                responseEvent = {
                    type: 'response',
                    command: event.command,
                    eventId: event.eventId,
                    names: []
                };

                writeEvent(socket, responseEvent);
                return;
            }

            responseEvent = {
                type: 'error',
                command: event.command,
                eventId: event.eventId,
                message: 'zfs list snapshot error: ' + error
            };

            writeEvent(socket, responseEvent);
            return;
        }

        // Example output:
        //   zones/9367e1db-c624-4aab-b91c-a920acaaaaaa@vmsnap-20191107T201928Z
        //   zones/9367e1db-c624-4aab-b91c-a920acaaaaaa@vm-migration-1
        //   zones/9367e1db-c624-4aab-b91c-a920acaaaaaa@vm-migration-2

        var lines = String(stdout).trim().split('\n');
        var seen = {};

        // Filter out snapshots that do not belong to this zfs filesystem.
        lines = lines.filter(function (line) {
            return line.startsWith(event.zfsFilesystem + '@');
        });

        var names = lines.map(function _lineMap(line) {
            return line.split('@').splice(-1)[0].trim();
        }).filter(function _duplicateFilter(name) {
            // Filter out empty names.
            if (!name) {
                return false;
            }
            // Filter out the duplicate named snapshots, which is possible for
            // a dataset that contains a child dataset.
            if (seen[name]) {
                return false;
            }
            seen[name] = true;
            return true;
        });

        responseEvent = {
            type: 'response',
            command: event.command,
            eventId: event.eventId,
            names: names
        };

        writeEvent(socket, responseEvent);
    });
}


function commandPing(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
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
    assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    opts.log.error({event: event}, 'Unimplemented command');

    var responseEvent = {
        type: 'error',
        command: event.command,
        eventId: event.eventId,
        message: 'Not Implemented',
        version: VERSION
    };

    writeEvent(socket, responseEvent);
}


function commandError(opts, event, socket) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.object(event, 'event');
    assert.object(socket, 'socket');

    opts.log.error({event: event}, 'Unknown command');

    var responseEvent = {
        type: 'error',
        command: event.command,
        eventId: event.eventId,
        message: 'Unknown command',
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
        log.error('Migrate-receive: invalid json: %s - ignoring', line);
        return;
    }

    switch (event.command) {
        case 'stop':
            commandStop(opts, event, socket);
            break;
        case 'ping':
            commandPing(opts, event, socket);
            break;
        case 'rate':
            commandNotImplemented(opts, event, socket);
            break;
        case 'status':
            commandNotImplemented(opts, event, socket);
            break;
        case 'get-zfs-resume-token':
            commandGetZfsResumeToken(opts, event, socket);
            break;
        case 'get-zfs-snapshot-names':
            commandGetZfsSnapshotNames(opts, event, socket);
            break;
        case 'sync':
            commandSync(opts, event, socket);
            break;
        case 'zfs-destroy':
            commandZfsDestroy(opts, event, socket);
            break;
        default:
            commandError(opts, event, socket);
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

    socket.on('timeout', function _onSocketTimeout() {
        log.warn('handleSocketConnection: socket timeout');
        socket.destroy();
    });

    socket.on('end', function _onSocketEnd() {
        log.debug('handleSocketConnection: socket.end received');
    });

    // Read what the socket wants us to do.
    var commandStream = new LineStream();
    opts.commandStream = commandStream;
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
function setupMigrationServer(opts, callback) {
    assert.object(opts, 'opts');
    assert.object(opts.log, 'opts.log');
    assert.func(callback, 'callback');

    var log = opts.log;

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
     * Create TCP Server which will handle migration target commands.
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
    assert.uuid(message.req_id, 'req_id');
    assert.optionalNumber(message.timeoutSeconds, 'timeoutSeconds');
    assert.uuid(message.uuid, 'uuid');

    var log = setupLogging(message.req_id);
    var opts = {
        log: log,
        req_id: message.req_id,
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

        setupMigrationServer(opts, function (err, response) {
            if (err) {
                process.send({error: { message: err.message, err: err.stack }});
                return;
            }

            process.send(response);
        });
    });
});
