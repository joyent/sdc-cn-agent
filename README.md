<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2019 Joyent, Inc.
-->

# sdc-cn-agent

This repository is part of the Joyent Triton project. See the [contribution
guidelines](https://github.com/joyent/triton/blob/master/CONTRIBUTING.md)
and general documentation at the main
[Triton project](https://github.com/joyent/triton) page.

sdc-cn-agent is an RPC mechanism via which a client can interact with a
compute node. It acts as an externally visible interface to subsystems within
the server. 

It is responsible for executing "tasks", scripts which break down some
unit of work into a number of steps to be completed.  This may range
from creating a virtual machine to something as simple as creating or listing
ZFS datasets.


# Repository

Some notable parts of the repo:

    node_modules/fw         This is a copy of smartos-live.git:src/fw
                            and should be kept in sync. It is used to
                            provide a node API to `fw.{update,del,add}`
                            for firewall data.


# Development

To run the cn-agent:

```
git clone git@github.com:joyent/sdc-cn-agent.git
cd sdc-cn-agent
git submodule update --init
npm install
sudo /usr/node/bin/node bin/cn-agent.js
```

The Linux port lacks some network knowledge.  For now, it should be this
instead:

```
sudo env ADMIN_IP=192.168.1.183 /usr/node/bin/node bin/cn-agent.js
```

## Linux port

Development should be done on a VM running
[linux-live](https://github.com/joyent/linux-live/tree/linuxcn).  You probably
want to perform the following one-time setup on that box:

The following steps will eventually be done by `joysetup` or similar.  For now
they are manual.

### One-time setup

```
zpool create triton $disk
touch /triton/.system_pool

zfs create -o canmount=noauto -o mountpoint=/ triton/platform
zfs create -o canmount=noauto triton/platform/etc
zfs create -o canmount=noauto triton/platform/etc/systemd
zfs create triton/platform/etc/systemd/system
zfs create -o canmount=noauto triton/platform/var
zfs create triton/platform/var/imgadm
zfs create triton/platform/var/ssh
zfs create -o canmount=noauto triton/platform/lib
zfs create triton/platform/lib/sdc
```

Put something like the following in /lib/sdc/config.sh:

```
#! /bin/bash

cat <<NOMORE
{
  "ufds_admin_uuid": "930896af-bf8c-48d4-885c-6573a94b1853",
  "imgapi_domain": "imgapi.coal-1.com",
  "fwapi_domain": "fwapi.coal-1.com",
  "binder_admin_ips": "10.99.99.11",
  "datacenter_name": "coal-1",
  "root_shadow": "\$6\$44Ksp7Uf\$Tu5IJnMVDkVVtWua.X13WNs.niE5Btj1Bdrcx6/7lwC/Ll8ai5Hs9bGn2C2fdKhebheWErEQgCRFEKYIYVhAV/",
  "ntp_hosts": "10.99.99.7",
  "ufds_admin_ips": "10.99.99.18",
  "vmapi_domain": "vmapi.coal-1.com",
  "root_authorized_keys_file": "root.authorized_keys",
  "dns_resolvers": "8.8.8.8,8.8.4.4",
  "assets_admin_ip": "10.99.99.8",
  "imgapi_admin_ips": "10.99.99.21",
  "dns_domain": "com",
  "rabbitmq": "guest:guest:10.99.99.20:5672",
  "dhcp_lease_time": "2592000",
  "sapi_domain": "sapi.coal-1.com",
  "vmapi_admin_ips": "10.99.99.26",
  "swap": "0.25x",
  "capi_client_url": "http://10.99.99.18:8080",
  "config_inc_dir": "/opt/smartdc/config"
}
NOMORE
```

The following are needed to be able to create persistent users, presuming you
don't do all your development as root.

```
zfs create triton/platform/etc/sysusers.d
zfs create triton/platform/etc/sudoers.d
zfs create -o mountpoint=/home triton/home
```

To create a persistent user:

```
user=bigbird
comment="Big Bird"
shell=/bin/bash
useradd -s $shell -c "$comment" -d /home/$user $user
echo "$user ALL=(ALL) NOPASSWD: ALL" > /etc/sudoers.d/$user
uid=$(getent passwd $user | cut -d: -f3)
echo "u $user $uid \"$comment\" /home/$user $shell" >/etc/sysusers.d/$user.conf
```

These bits will eventually become part of agents (or are only needed on dev
machines):

```
apt update
apt install -y git
git clone https://github.com/joyent/node-imgadm /opt/img
git clone https://github.com/joyent/sdc-imgapi-cli /opt/sdc-imgapi-cli
```

Until `cn-agent` is ported:

```
mkdir -p /opt/smartdc/agents/etc/
echo '{ "no_rabbit": true }' > /opt/smartdc/agents/etc/cn-agent.config.json
```
### After every boot

You may want to create a service if you are rebooting frequently.

```
apt update
apt install -y git build-essential autoconf libtool
```

The plan:

- Initially no support for:
  - Docker
  - Snapshots
  - Migration
- Rely on systemd as much as possible to serve as a level playing field for
  whatever distro(s) is/are supported in the end.  Avoid libvirt-lxc, as that is
  on the outs with RedHat/Centos/OracleLinux and perhaps Fedora in the future.

### Example: sysinfo

In the SmartOS version, sysinfo is a bash script that processes text.  Various
Linux tools are happy to print configuration in JSON, implying bash is the wrong
tool.  The following script can be used to see sysinfo output:

```
#! /usr/node/bin/node

sysinfo = require('/__FIXME__/sdc-cn-agent/lib/backends/linux/sysinfo');

// If there is an error, it is probably a MultiError (see VError module).
// If you run this without root privs, dmidecode will fail but everything else
// should succed.  When cn-agent runs calls sysInfo(), it fails if any errors
// are returned.
sysinfo.sysInfo(null, function (err, info) {
    console.log(JSON.stringify(info, null, 2))
});
```

## Examples

See the [examples](examples) directory for scripts that call the various
actions.
