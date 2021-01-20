<!--
    This Source Code Form is subject to the terms of the Mozilla Public
    License, v. 2.0. If a copy of the MPL was not distributed with this
    file, You can obtain one at http://mozilla.org/MPL/2.0/.
-->

<!--
    Copyright 2021 Joyent, Inc.
-->

# sysinfo data dictionary

On success, the `server_sysinfo` task will return an object with the structure
described below.

## Data Dictionary

Most fields are nearly self-explanatory, but there are a couple surprises.


| Key        | Type    | Description                                           |
| ---------- | ------- | ------------------------------------------------------|
| Admin IP   | string  | One IP address that is on the admin network.  Agents tend to bind to this address so they are only reachable from the admin network.  |
| Admin NIC Tag | string | The NIC tag for the amdin network. The typical value is "admin" |
| Bhyve Capable | boolean | Is this machine capable of running bhyve guests? |
| Bhyve Max Vcpus | integer | If Bhyve Capable, how many CPUs  may a guest have?  |
| Boot Parameters | string | The kernel command line |
| Boot Time | integer | Seconds since epoch |
| CPU Core Count | integer | Number of CPU cores.  |
| CPU Count | integer | Number of CPU threads.  Use *CPU Online Count* instead |
| CPU Online Count | integer | *CPU Count*, minus those that are offline. Consumers that care about how many CPUs a system has should use this value. |
| CPU Physical Cores | integer | Same as *CPU Socket Count*. Do not use this. |
| CPU Socket Count | integer | Number of sockets or packages.  |
| CPU Total Cores | integer | Same as *CPU Count*.  Do not use this.  Use *CPU Online Count* |
| CPU Type | string | Processor Version, as described in Section 7.5 of [DSP0134 3.3.0](https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_3.3.0.pdf). Use *HW Version* instead. |
| CPU Virtualization | string | The instruction set used for accellerating HVM instances.  One of: "vmx" "svm" "none" |
| Datacenter Name | string | See *Datacenter Name* in [Triton deployment planning](https://docs.joyent.com/private-cloud/install/deployment-planning). |
| Disks | integer | The number of disks in the compute node |
| Fixed UUID | string | UUID as described in Section 7.2 of  [DSP0134 3.3.0](https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_3.3.0.pdf).  **Caution:** Compare to *UUID*.  Example: *28726555-6769-4201-a965-6b7be4e6e9b6* |
| HVM API | boolean | Can KVM and Bhyve run concurrently? |
| HW Family | string | Processor Family, as described in Section 7.5 of [DSP0134 3.3.0](https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_3.3.0.pdf). Example: *Xeon* |
| HW Version | string | Processor Version, as described in Section 7.5 of [DSP0134 3.3.0](https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_3.3.0.pdf). Example: *Intel(R) Xeon(R) Silver 4110 CPU @ 2.10GHz* |
| Hostname | string | Like the same as reported by the `hostname` command. |
| Link Aggregations | object | See *Link Aggregations* section below. |
| Live Image | string | The platform image (PI) version, which is typically an IS0 8601 timestamp of the time that the image was built. **Caution:** a higher version number only indicates the time of the build, not which branch it was built from.  With backports to an old branch, a recent PI version can be found on an image built from a non-so-recent branch. |
| Manufacturer | string | Manufacturer, as described in Section 7.5 of [DSP0134 3.3.0](https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_3.3.0.pdf). Example: *Intel(R) Corporation* |
| MiB of Memory | integer | Number of bytes of memory divided by 2^20. |
| Network Interfaces | object | See *Network Interfaces* section below. |
| Product | string | Product Name as described in Section 7.2 of  [DSP0134 3.3.0](https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_3.3.0.pdf). Example: *IXWS-731I-403B-IXN* |
| Psrinfo | object | See *Psrinfo* section below. |
| SDC Agents | array | See *SDC Agents* section below. |
| SDC Version | string | Currently "7.0" |
| SKU Number | string | SKU Number as described in Section 7.2 of  [DSP0134 3.3.0](https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_3.3.0.pdf). Example: *IXWS-731I-403B-IXN* |
| Serial Number | string | Serial Number as described in Section 7.2 of  [DSP0134 3.3.0](https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_3.3.0.pdf). Example: *IXWS-731I-403B-IXN* |
| UUID | string | UUID as described in Section 7.2 of  [DSP0134 3.3.0](https://www.dmtf.org/sites/default/files/standards/documents/DSP0134_3.3.0.pdf).  **Caution:** SmartOS obtains this value via `smbios` and improperly handles endian issues.  See *Fixed_UUID*.  Example: *55657228-6967-0142-a965-6b7be4e6e9b6*|
| VM Capable | boolean | Can the machine run hardware accelerated HVM instances? |
| Virtual Network Interfaces | object | See *Virtual Network Interfaces* section below. |
| Zpool | string | The name of the system ZFS pool, which is the default pool that will be used for images and instances. |
| Zpool Creation | integer | Time that *Zpool* was created, in seconds since the epoch. |
| Zpool Disks | string | Comma separated list of disks in *Zpool* |
| Zpool Encrypted | boolean | Is encryption enabled on the top-level dataset of *Zpool*? |
| Zpool Size in GiB | integer | Size of *Zpool* |

### Link Aggregations

This is a representation of the current state, which may differ from desired state.

Example:

```json
{
  "aggr0": {
    "LACP Mode": "off",
    "Interfaces": [ "i40e0", "i40e2" ]
  }
}
```

### Network Interfaces

This is a representation of the current state, which may differ from desired state.

Example:

```json
{
  "ixgbe0": {
    "MAC Address": "90:e2:ba:ab:cd:ef",
    "ip4addr": "10.23.45.67",
    "Link Status": "up",
    "NIC Names": [
      "admin"
    ]
  },
  "ixgbe1": {
    "MAC Address": "90:e2:ba:ab:cd:ff",
    "ip4addr": "",
    "Link Status": "up",
    "NIC Names": [
      "external"
    ]
  }
}

### Psrinfo

Example:

```
{
  "smt_enabled": true
}
```

| Key        | Type    | Description                                           |
| ---------- | ------- | ------------------------------------------------------|
| smt\_enabled | boolean | Is hyper-threading enabled?  See [Controlling hyper-threading](https://docs.joyent.com/private-cloud/install/server-parameters#controlling-hyper-threading) |

### SDC Agents

Example:

```json
[
  {
    "name": "agents_core",
    "version": "2.2.2"
  },
  {
    "name": "smartlogin",
    "version": "0.2.2"
  },
  ...
]
```

### Virtual Network Interfaces

Example

```json
{
  "external0": {
    "MAC Address": "02:08:20:12:34:56",
    "ip4addr": "3.4.5.6",
    "Link Status": "up",
    "Host Interface": "ixgbe1",
    "VLAN": "3304"
  }
}
```

The outer key on a Virtual Network Interface is the name of the interface.
Attributes of that interface are:

| Key        | Type    | Description                                           |
| ---------- | ------- | ------------------------------------------------------|
| MAC Address | string | MAC Address |
| ip4addr    | string  | IPv4 address |
| Link Status | string | "up" or "down" |
| Host Interface| string | The physical interface or aggr that this virtual interface uses. |
| VLAN       | integer | VLAN id |
| Overlay Nic Tags | string | Comma separated list of NIC tags provided by this NIC.  See [Nic Tags](https://github.com/joyent/sdc-napi/blob/master/docs/index.md#nic-tags) in NAPI documentation. |
