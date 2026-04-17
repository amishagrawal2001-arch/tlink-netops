# Tlink NetOps

**Professional Network Topology Design & Management**

Design, visualize, and manage complex network topologies with an enterprise-grade drag-and-drop interface, real-time monitoring, and integrated device management.

---

## Screenshots

> _Visit [tlink.io](https://tlink.io) to see Tlink NetOps in action._

---

## Features

### Topology Design
- **Interactive 2D + 3D Canvas** -- drag-and-drop editor with pan/zoom, plus immersive Three.js WebGL 3D view
- **170+ Pre-built Templates** -- datacenter, WAN, campus, SP, EVPN-VXLAN, SR-MPLS, SRv6, CRB, ERB
- **13 Vendors** -- Juniper, Cisco (IOS/NX-OS/IOS-XR), Arista, Nokia (SRL/SROS), SONiC, Huawei, Dell, HPE, MikroTik, Extreme
- **Device Library** -- routers, switches, firewalls, servers, cloud nodes, hosts, bridges
- **Link Management** -- styled connections with waypoints, auto IP assignment (/24–/31), labels
- **Annotations** -- rectangles, ellipses, text labels, and embedded images

### Routing Protocols & Services
- **Set Protocol Dialog** -- bulk-assign eBGP, iBGP-RR, OSPF, OSPFv3, IS-IS with auto-loopbacks & validation warnings
- **Segment Routing** -- SR-MPLS (Node-SID + SRGB) and SRv6 (unique locators) with one-click enablement
- **TI-LFA** -- topology-independent fast reroute with node protection (Juniper)
- **Service Profiles** -- EVPN-VXLAN, CRB (centrally-routed), ERB (edge-routed), 3-Tier DC, Campus LAN, MPLS SP Core, SR-MPLS L3VPN, K8s Fabric, Branch Office
- **Auto-Generate Configs** -- vendor-specific startup configs for all 13 vendors
- **Vendor Config Export** -- complete, deployment-ready configs per node

### Simulation & Deployment
- **One-Click Containerlab Deploy** -- deploy topology as containerlab lab with auto-configured BGP/EVPN
- **Multi-Server Support** -- deploy labs on any remote Docker host via SSH
- **Ansible / Terraform / GNS3 Export** -- infrastructure-as-code for real deployments
- **Firmware Upgrade Plans** -- staged, ordered upgrade workflows

### Digital Twin & Monitoring
- **Live Dashboard** -- real-time CPU, memory, BGP state, alarms, config drift
- **SSH & SNMP Polling** -- with connection pooling (3/host, 50 total)
- **LLDP/CDP Auto-Discovery** -- BFS neighbor walking to build topologies from live networks
- **Physical Device Mapping** -- map virtual topology nodes to real hardware, bulk CSV/JSON import
- **Multi-Server Container Polling** -- backend server SSHes into remote Docker hosts
- **Integrated SSH Terminal** -- xterm.js-powered console

### Automation
- **Event-Driven Rules** -- 8 triggers × 5 actions (webhooks, SSH commands, Slack, etc.)
- **Workflow Editor** -- drag-and-drop workflow builder with loops and conditionals
- **Change Management** -- propose → approve → deploy → verify → rollback with audit trail
- **Compliance Checks** -- automated policy validation
- **Scheduled Jobs** -- cron-based recurring tasks

### Productivity
- **Undo / Redo** -- snapshot-based state management
- **Keyboard Shortcuts** -- F1 for help, ? for shortcuts overlay, 170+ keyboard shortcuts
- **Viewport Culling** -- performance optimization for large topologies (80+ nodes)
- **Context Menus** -- right-click actions on nodes, links, and canvas
- **Guided Tour** -- 14-step interactive onboarding

### Enterprise
- **Cross-Platform** -- macOS (Intel/Apple Silicon), Windows, Linux (AppImage/deb/rpm)
- **Optional Backend Server** -- standalone Node.js server for large-scale polling & shared labs
- **Dark & Light Themes** -- professional interface with theme support

---

## System Requirements

| Platform | Requirement |
|---|---|
| **macOS** | macOS 11 (Big Sur) or later |
| **Windows** | Windows 10 or later |
| **Linux** | Ubuntu 20.04+, Fedora 36+, or equivalent |
| **RAM** | 4 GB minimum, 8 GB recommended |
| **Disk** | 200 MB free space |

---

## Installation

Download the latest version for your platform from [tlink.io](https://tlink.io).

| Platform | Format |
|---|---|
| macOS | `.dmg` |
| Windows | `.exe` installer |
| Linux | `.AppImage`, `.deb`, `.rpm` |

---

## Getting Started

1. **Download & Install** -- Get Tlink NetOps from [tlink.io](https://tlink.io) and run the installer for your platform.
2. **Launch** -- Open Tlink NetOps. You will be greeted with a 14-day free trial.
3. **Create a Topology** -- Use File > New to create a blank topology, or choose from built-in templates.
4. **Add Devices** -- Drag devices from the palette on the left onto the canvas.
5. **Connect Devices** -- Click a device port to start drawing a link, then click the target device port.
6. **Configure** -- Right-click devices to access properties, terminal access, and SNMP configuration.
7. **Save & Export** -- Save your topology (Ctrl/Cmd+S) or export inventory reports.

---

## Keyboard Shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + Z` | Undo |
| `Ctrl/Cmd + Shift + Z` | Redo |
| `Ctrl/Cmd + A` | Select all |
| `Ctrl/Cmd + C` | Copy selection |
| `Ctrl/Cmd + V` | Paste |
| `Delete / Backspace` | Delete selection |
| `Ctrl/Cmd + S` | Save topology |
| `Ctrl/Cmd + O` | Open topology |
| `Ctrl/Cmd + N` | New topology |
| `Escape` | Deselect / cancel |
| `+` / `-` | Zoom in / out |
| `Ctrl/Cmd + 0` | Reset zoom |

---

## Subscription Plans

| Feature | Free Trial | Professional | Enterprise |
|---|---|---|---|
| Duration | 14 days | Monthly | Monthly |
| Price | Free | $29/mo | $99/mo |
| All design features | Yes | Yes | Yes |
| SNMP monitoring | Yes | Yes | Yes |
| SSH terminal | Yes | Yes | Yes |
| Export & reporting | Yes | Yes | Yes |
| Priority support | -- | Email | Email + Phone |
| Custom integrations | -- | -- | Yes |
| SSO / SAML | -- | -- | Yes |
| Dedicated account manager | -- | -- | Yes |

Visit [tlink.io/pricing](https://tlink.io/pricing) to choose your plan.

---

## Support

- **Documentation**: [tlink.io/docs](https://tlink.io/docs)
- **Email**: support@tlink.io
- **Sales**: sales@tlink.io
- **Website**: [tlink.io](https://tlink.io)

---

(c) 2026 Tlink Technologies. All rights reserved.

This software is proprietary. See [LICENSE](LICENSE) for details.
