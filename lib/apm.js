/*
 * This Source Code Form is subject to the terms of the Mozilla Public
 * License, v. 2.0. If a copy of the MPL was not distributed with this
 * file, You can obtain one at http://mozilla.org/MPL/2.0/.
 */

/*
 * Copyright 2021 Joyent, Inc.
 */

/*
 *
 * apm.js - Ain't a Package Manager
 *
 * Drops Node.js packages into a given directory tree. Links up binaries. Runs
 * your lifecycle scripts.
 *
 * Eg. ./bin/apm.js list 2> >(bunyan)
 *
 */

var assert = require('assert-plus');
var async = require('async');
var bunyan = require('bunyan');
var mkdirp = require('mkdirp');
var fs = require('fs');
var createHash = require('crypto').createHash;
var execFile = require('child_process').execFile;
var exec = require('child_process').exec;
var spawn = require('child_process').spawn;
var path = require('path');
var vasync = require('vasync');
var VError = require('verror');

var prefix = '/opt/smartdc/agents';
var tmp = '/var/tmp';
var modules = 'lib/node_modules';
var installdir = prefix + '/' + modules;
var bindir = prefix + '/bin';
var smfdir = prefix + '/smf';
var etcdir = prefix + '/etc';
var dbdir = prefix + '/db';
var log;

function readPackageJson(jsonPath, callback) {
    fs.readFile(jsonPath, function (error, json) {
        return callback(null, JSON.parse(json));
    });
}

function createPackageLibDirectory(thing, callback) {
    var dir = prefix + '/lib/node_modules/' + thing;
    log.debug('Creating directory, %s', dir);
    mkdirp(dir, function (error) {
        if (error) {
            log.error('Could not create directory, %s', dir);
            return callback(error);
        }
        return callback(error);
    });
}

function isPackageInstalled(pkg, callback) {
    var dir = path.join(installdir, pkg);
    log.info('Checking if package, %s, is installed.', dir);
    fs.exists(dir, function (exists) {
        if (!exists) {
            log.info('Package, %s, is not installed.', pkg);
            return callback(null, false);
        }
        return fs.stat(dir, function (error, stat) {
            if (error) {
                log.error('Package, %s, could not be stat: %s', error.message);
                return callback(error, false);
            }

            if (stat.isDirectory()) {
                log.info('Package, %s, is installed.', pkg);
                return callback(null, true);
            } else {
                log.warn(
                    'Package install location, %s, is not a directory?', dir);
                return callback(null, false);
            }
        });
    });
}

function tmpname() {
    return 'apm-' + Date.now() + Math.random();
}

function runLifecycleScript(which, packageJson, pkgPath, callback) {
    // Run lifecycle scripts.
    var scripts = packageJson.scripts;

    log.info('Checking for lifecycle script, %s.', which);

    if (!(scripts && scripts[which])) {
        log.info('No %s script found, continuing.', which);
        return callback();
    }

    var script = scripts[which];

    if (!script) {
        return callback();
    }

    process.chdir(pkgPath);

    return fs.stat(script, function (error, stat) {
        if (error) {
            log.warn(
                'Warning: Error could not stat lifescyle script %s.',
                error.message);
            return callback(error);
        }

        // Copy process.env
        var i;
        var env = {};
        for (i in process.env) {
            env[i] = process.env[i];
        }

        // Add our properties
        var addToEnv = {
            npm_config_prefix: prefix,
            npm_config_smfdir: smfdir,
            npm_package_name: packageJson.name,
            npm_package_version: packageJson.version,
            npm_config_etc: etcdir,
            npm_config_dbdir: dbdir
        };

        for (i in addToEnv) {
            if (addToEnv.hasOwnProperty(i)) {
                env[i] = addToEnv[i];
            }
        }

        log.info('Executing %s', script);
        var child = spawn(script, [], { env: env });

        child.stdout.on('data', function (data) {
            log.debug('stdout: ' + data.toString());
        });

        child.stderr.on('data', function (data) {
            log.debug('stderr: ' + data.toString());
        });

        return child.on('exit', function (code) {
            console.log('Finished executing ' + which);
            if (code) {
                log.error(which + ' exited with ' + code);
                return callback(new Error(which + ' returned ' + code));
            }
            return callback();
        });
    });
}

/*
 * Uninstall the given APM package.
 *
 * It is not an error if the package doesn't look like it exists.
 * In this case this will `log.warn`.
 */
function uninstallPackage(opts, cb) {
    assert.object(opts, 'opts');
    assert.string(opts.packageName, 'opts.packageName');
    assert.optionalBool(opts.removeInstanceUuidFile,
        'opts.removeInstanceUuidFile');
    assert.func(cb, 'cb');

    log.info('Uninstalling package %s', opts.packageName);

    var pkgPath = path.join(prefix, modules, opts.packageName);
    var pkgInstUuidFile = path.join(etcdir, opts.packageName);

    vasync.pipeline({arg: {}, funcs: [
        function checkIfPkgPathExists(ctx, next) {
            fs.stat(pkgPath, function (err, stats) {
                if (err) {
                    if (err.code === 'ENOENT') {
                        log.warn(
                            'package "%s" does not appear to be installed: %s',
                            opts.packageName, err.message);
                        ctx.pkgPathExists = false;
                        next();
                    } else {
                        next(err);
                    }
                } else {
                    ctx.pkgPathExists = true;
                    next();
                }
            });
        },

        function readThePackageJson(ctx, next) {
            if (!ctx.pkgPathExists) {
                next();
                return;
            }
            readPackageJson(pkgPath + '/package.json', function (err, json) {
                if (err) {
                    next(err);
                } else {
                    ctx.packageJson = json;
                    log.trace({packageJson: ctx.packageJson},
                        'loaded package.json');
                    next();
                }
            });
        },

        function runPreuninstall(ctx, next) {
            if (!ctx.packageJson) {
                next();
                return;
            }
            runLifecycleScript('preuninstall', ctx.packageJson, pkgPath, next);
        },
        function runPostuninstall(ctx, next) {
            if (!ctx.packageJson) {
                next();
                return;
            }
            runLifecycleScript('postuninstall', ctx.packageJson, pkgPath, next);
        },

        function rmBinLinks(ctx, next) {
            // Iterate over packageJson bin entries and remove them from our
            // bin directory.
            if (!ctx.packageJson || !ctx.packageJson.bin ||
                !Object.keys(ctx.packageJson.bin).length) {
                next();
                return;
            }

            var bins = ctx.packageJson.bin;
            var binNames = Object.keys(bins);

            async.eachSeries(
                binNames,
                function (binName, nextBinName) {
                    var binLink = bindir + '/' + binName;

                    fs.stat(binLink, function (statErr) {
                        if (statErr) {
                            log.warn('Could not stat %s to unlink', binLink);
                            nextBinName();
                            return;
                        }

                        fs.unlink(binLink, function (unlinkError) {
                            if (unlinkError) {
                                nextBinName(unlinkError);
                            } else {
                                log.info('Unlinked %s', binLink);
                                nextBinName();
                            }
                        });
                    });
                },
                next);
        },

        function rmPkgPath(ctx, next) {
            if (!ctx.pkgPathExists) {
                next();
                return;
            }

            // Ensure CWD is not inside the dir we are removing.
            process.chdir(path.join(prefix, modules));

            execFile('/usr/bin/rm', [ '-fr', pkgPath ],
                function (execErr, stdout, stderr) {
                    if (execErr) {
                        next(new VError(execErr, 'could not remove %s: %s',
                            pkgPath, stderr));
                    } else {
                        log.info('Removed pkgPath: %s', pkgPath);
                        next();
                    }
                });
        },

        function removeTheInstUuidFile(ctx, next) {
            if (!opts.removeInstanceUuidFile) {
                next();
                return;
            }
            fs.unlink(pkgInstUuidFile, function onUnlink(err) {
                if (err) {
                    if (err.code === 'ENOENT') {
                        next();
                    } else {
                        next(err);
                    }
                } else {
                    log.info('Removed instance_uuid file:', pkgInstUuidFile);
                    next();
                }
            });
        }
    ]}, function onFinish(err) {
        if (err) {
            log.error(err, 'Error uninstalling package %s', opts.packageName);
            cb(err);
        } else {
            cb();
        }
    });
}

function installPackage(toInstall, cb) {
    var localtmp = tmp + '/' + tmpname();
    var thingdir;
    var installeddir;
    var packageJson;
    var packagetmp = localtmp + '/package';

    async.waterfall([
        function (callback) {
            async.eachSeries(
                [ packagetmp, localtmp, installdir, bindir, smfdir, etcdir ],
                function (dir, _cb) {
                    mkdirp(dir, _cb);
                },
                callback);
        },
        function (callback) {
            fs.stat(toInstall, function (error, stat) {
                if (error) {
                    callback(error);
                    return;
                }

                if (stat.isDirectory()) {
                    execFile(
                        '/usr/bin/cp',
                        [ '-Pr', toInstall, packagetmp + '/pkg' ],
                        function (execError, stdout, stderr) {
                            if (execError) {
                                callback(
                                    new Error(
                                        'Error copying install source: '
                                        + execError.message));
                                return;
                            }
                            process.chdir(localtmp);
                            callback();
                            return;
                        });
                    return;
                } else if (stat.isFile()) {
                    var cmd = '/usr/bin/tar zxf ' + toInstall + ' -C ' +
                        packagetmp;

                    function onExec(err, stdout, stderr) {
                        if (err) {
                            log.error(stderr.toString());
                            log.error(err.message);
                            log.error(err.stack);
                            callback(error);
                        }
                        callback();
                    }

                    exec(cmd, onExec);
                    return;
                } else {
                    var msg = 'Installation source had unknown type.';
                    log.error(msg);
                    callback(new Error(msg));
                    return;
                }
            });
        },
        function (callback) {
            // Find a single package directory in `localtmp`.
            fs.readdir(packagetmp, function (error, list) {
                assert(list.length > 0,
                'There should be at least 1 directory in package tarball');
                thingdir = packagetmp + '/' + list[0];
                process.chdir(thingdir);
                return callback();
            });
        },
        function (callback) {
            // Parse the package's package.json file.
            readPackageJson(thingdir + '/package.json', function (error, json) {
                packageJson = json;
                return callback();
            });
        },
        function (callback) {
            var name = packageJson.name;
            isPackageInstalled(name, function (error, isInstalled) {
                if (isInstalled) {
                    log.warn('Detected %s as being already installed. '
                        + 'Uninstalling before continuing.', name);
                    uninstallPackage({
                        packageName: name,
                        removeInstanceUuidFile: false
                    }, function onUninstall(_uninstallErr) {
                        // Ignore possible uninstall error. It is logged in
                        // `uninstallPackage`.
                        callback();
                    });
                } else {
                    callback();
                    return;
                }
            });
        },
        function (callback) {
            runLifecycleScript(
                'preinstall',
                packageJson,
                thingdir,
                function (error) {
                    if (error) {
                        return callback(error);
                    }
                    return callback();
                });
        },
        function (callback) {
            // Move the unpacked package directory into its final home.
            installeddir = installdir + '/' + packageJson.name;

            execFile('/usr/bin/mv', [thingdir, installeddir],
                function (error, stdout, stderr) {
                    log.info('Moving %s => %s', thingdir, installeddir);
                    return callback(
                        error ? new Error(stderr.toString()) : null);
                });
        },
        function (callback) {
            process.chdir(installeddir);
            // Move the unpacked package directory into its final home.
            execFile('/usr/bin/rm', [ '-fr', localtmp ],
                function (error, stdout, stderr) {
                    log.info('Deleting temp directory: %s', localtmp);
                    return callback(
                        error ? new Error(stderr.toString()) : null);
                });
        },
        function (callback) {
            var bins = packageJson.bin;
            var binNames;

            // Link up bin/ entries.
            if (!(bins && Object.keys(bins).length)) {
                return callback();
            }

            binNames = Object.keys(bins);

            return async.eachSeries(binNames, function (binName, _cb) {
                var from = bindir + '/' + binName;
                var to = [
                    '..',
                    modules,
                    packageJson.name,
                    packageJson.bin[binName].replace(new RegExp('^\\.\/'), '')
                ].join('/');

                var toPath = path.resolve(bindir, to);
                fs.chmod(toPath, parseInt('755', 8), function (error) {
                    if (error) {
                        log.error('Error chmod %s.', toPath);
                        return _cb(error);
                    }

                    return fs.symlink(to, from, function (symlinkError) {
                        if (symlinkError) {
                            log.error(
                                'Error symlinking %s to %s: %s',
                                from, toPath, symlinkError.message);
                            return _cb(error);
                        }
                        log.info('Symlinked %s => %s', from, toPath);
                        return _cb();
                    });
                });
            }, callback);
        },
        function (callback) {
            runLifecycleScript(
                'postinstall',
                packageJson,
                installeddir,
                function (error) {
                    if (error) {
                        return callback(error);
                    }
                    return callback();
                });
        }
    ], cb);
}


function updateSysinfo(callback) {
    // Nowadays `sysinfo` call on Linux does not cache anything.
    // Either way, we'll keep the function call here just in case
    // this changes in the future.
    callback();
}


function command_install(apm) {

    var things = process.argv.slice(3);

    apm.installPackages(things, function (err) {
        if (err) {
            process.exit(1);
        }
        return;
    });
}


function command_uninstall(apm) {
    var packages = process.argv.slice(3);

    apm.uninstallPackages(packages, function onUninstalled(_err) {
        // For compatibility, we ignore possible uninstall error. It is logged
        // in `uninstallPackages`. At some point it would be good to exit
        // non-zero on uninstall error.
    });
}


function command_list(apm) {
    apm.getPackages(function (err, packages) {
        if (err) {
            process.exit(1);
        }
        packages.forEach(function (pkg) {
            process.stdout.write((pkg.name + ' ' + pkg.version || '') + '\n');
        });
    });
}


function APM(options) {
    log = options.log;
}


APM.prototype.installPackages = function (packages, callback) {

    var errors = [];

    async.eachSeries(packages, function (_package, cb) {
        installPackage(_package, function (error) {
            if (error) {
                log.error('Error installing %s: %s',
                        _package, error.message);
                errors.push({
                    source: _package,
                    message: error.message,
                    stack: error.stack
                });
                return cb();
            }
            return cb();
        });
    },
    function (error) {
        updateSysinfo(function (sysinfoError) {
            if (sysinfoError) {
                log.error(
                    'Error updating sysinfo: ',
                    sysinfoError.message);
            }
            log.info('Done installing all packages.');
            if (errors.length) {
                log.error({errors: errors},
                    'errors installing packages');
                if (callback) {
                    callback(new Error('Errors installing packages, ' +
                        'first error: ' + JSON.stringify(errors[0])));
                }
                return;
            }
            if (callback) {
                callback();
            }
            return;
        });
    });
};

/*
 * Uninstall the given packages.
 *
 * For each given package name this will:
 * - run any 'preuninstall' and 'postuninstall' lifecycle scripts
 * - remove any scripts from /opt/smartdc/agents/bin listed in the package's
 *   package.json "bin" object
 * - remove the install dir (/opt/smartdc/agents/lib/node_modules/$packageName)
 * - remove the "instance uuid file" (/opt/smartdc/agents/etc/$packageName)
 *   that is commonly created by Triton agents.
 *
 * It is *not* an error if none of these exist, i.e. if the package is not
 * installed or if a bogus name is given. This is so package/agent removal
 * can be idempotent.
 *
 * @param {Array} packages - A list of package names to uninstall.
 * @param {Function} callback - `function (err)`.
 */
APM.prototype.uninstallPackages = function (packages, callback) {
    var errs = [];

    async.eachSeries(packages, function (packageName, cb) {
        uninstallPackage({
            packageName: packageName,
            removeInstanceUuidFile: true
        }, function onUninstalledPackage(unErr) {
            if (unErr) {
                var err = new VError(unErr, 'error uninstalling %s',
                    packageName);
                log.error(err);
                errs.push(err);
            }
            cb();
        });
    },
    function onFinish(finishErr) {
        assert(!finishErr, 'the code above should never call cb with an error');
        updateSysinfo(function (sysinfoErr) {
            if (sysinfoErr) {
                errs.push(sysinfoErr);
                log.error(sysinfoErr, 'error updating sysinfo');
            }
            log.info('Done uninstalling all packages');
            callback(VError.errorFromList(errs));
        });
    });
};

APM.prototype.getPackages = function (callback) {
    var packages = [];

    fs.readdir(installdir, function (dirError, files) {
        if (dirError) {
            log.error('Error reading ' + installdir);
            callback(dirError);
            return;
        }

        files = files.sort();

        async.each(files, function (f, cb) {
            var fn = path.join(installdir, f, 'package.json');
            var exists = fs.existsSync(fn);
            if (!exists) {
                log.warn(
                    'No package.json found in ' +
                    path.join(installdir, f));
                cb();
                return;
            }

            fs.readFile(fn, function (error, data) {
                var pkg = JSON.parse(data.toString());
                packages.push(pkg);
                cb();
            });
        }, function (error) {
            if (error) {
                log.error('Error: ' + error.message);
                callback(error);
            } else {
                callback(null, packages);
            }
        });
    });
};


function main(logger) {

    var apm;
    var commands = {
        install:   command_install,
        uninstall: command_uninstall,
        list:      command_list
    };

    var command = process.argv[2];

    apm = new APM({log: logger});

    if (!command) {
        console.warn('Command missing.');
        process.exit(1);
    }

    if (!commands.hasOwnProperty(command)) {
        console.warn('Unkown command: %s', command || '');
        process.exit(1);
    }

    commands[command](apm);
}

if (require.main === module) {
    log = bunyan.createLogger({
        name: 'apm',
        stream: process.stderr,
        level: 'debug'
    });

    main(log);
} else {
    module.exports = {
        APM: APM
    };
}
