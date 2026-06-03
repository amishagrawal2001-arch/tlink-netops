import {
    ChangeDetectionStrategy, ChangeDetectorRef,
    Component, EventEmitter, Input, OnChanges, OnDestroy, OnInit,
    Output, SimpleChanges,
} from '@angular/core'
import { Subscription } from 'rxjs'
import { TopologyService } from '../services/topology.service'
import { InventoryService } from '../services/inventory.service'
import {
    TopologyNode, TopologyLink, NodePort, NodeTypeMeta, PortSpeed, SwitchFamily,
    PortVlanMode, VlanDefinition, NodeRole,
    VlanTemplate, VlanTemplateCategory, VLAN_TEMPLATES,
    NODE_TYPE_META, NODE_ROLE_META, RAM_PRESETS, PORT_SPEED_PRESETS,
    SERVER_IMAGE_PRESETS, ServerImagePreset, ServerImageCategory,
    SERVICE_PROFILES,
    parseVlanList, compactVlanList,
    PollSyncProposal,
    ConfigBackupEntry,
    ConfigSnippet, SnippetCategory,
} from '../api/interfaces'
import { NetopsSshRequest } from '../api/netops-api'
import { buildVendorStartupConfig, VendorConfigContext, asnToAsdot, is4ByteAsn } from '../services/vendor-config-builder'
import { getVendorCommands } from '../services/vendor-command-map'
import { mergeStaging, renderStagingConfig, buildStagingPushCommands, isSupportedStagingVendor } from '../services/vendor-staging-builder'
import { validateConfig, ValidationResult, smokeTestForVendor } from '../services/config-validator'
import { loadDeviceInventory, resolveSshCredentials } from '../services/inventory-creds'

type PanelTab = 'info' | 'ports' | 'vlans' | 'config' | 'staging' | 'notes' | 'links' | 'inv'
type JuniperPortGroup = { count: number; suffix: 'ge' | 'xe' | 'et'; speeds: PortSpeed[] }

interface QfxModelProfile {
    model: string
    label: string
    description: string
    portGroups: JuniperPortGroup[]
}

const QFX_MODEL_PROFILES: QfxModelProfile[] = [
    {
        model: 'QFX5120-48T',
        label: 'QFX5120-48T',
        description: '48 x 1/10GbE RJ-45 and 6 x 40/100GbE QSFP+/QSFP28',
        portGroups: [
            { count: 48, suffix: 'ge', speeds: ['1G', '10G'] },
            { count: 6, suffix: 'et', speeds: ['40G', '100G'] },
        ],
    },
    {
        model: 'QFX5120-48Y',
        label: 'QFX5120-48Y',
        description: '48 x 1/10/25GbE SFP/SFP+ and 8 x 40/100GbE QSFP+/QSFP28',
        portGroups: [
            { count: 48, suffix: 'xe', speeds: ['1G', '10G', '25G'] },
            { count: 8, suffix: 'et', speeds: ['40G', '100G'] },
        ],
    },
    {
        model: 'QFX5120-48YM',
        label: 'QFX5120-48YM',
        description: '48 x 1/10/25GbE SFP/SFP+ and 8 x 40/100GbE QSFP+/QSFP28',
        portGroups: [
            { count: 48, suffix: 'xe', speeds: ['1G', '10G', '25G'] },
            { count: 8, suffix: 'et', speeds: ['40G', '100G'] },
        ],
    },
    {
        model: 'QFX5120-32C',
        label: 'QFX5120-32C',
        description: '32 x 40/100GbE QSFP+/QSFP28 and 2 x 10GbE SFP+',
        portGroups: [
            { count: 32, suffix: 'et', speeds: ['40G', '100G'] },
            { count: 2, suffix: 'xe', speeds: ['10G'] },
        ],
    },
    {
        model: 'QFX5230-64CD',
        label: 'QFX5230-64CD',
        description: '64 x 400GbE QSFP56-DD (breakout capable)',
        portGroups: [{ count: 64, suffix: 'et', speeds: ['25G', '100G', '200G', '400G'] }],
    },
    {
        model: 'QFX5130-32CD',
        label: 'QFX5130-32CD',
        description: '32 x 400GbE QSFP-DD/QSFP+/QSFP28 and 2 x 10GbE SFP+',
        portGroups: [
            { count: 32, suffix: 'et', speeds: ['40G', '100G', '400G'] },
            { count: 2, suffix: 'xe', speeds: ['10G'] },
        ],
    },
    {
        model: 'QFX5130E-32CD',
        label: 'QFX5130E-32CD',
        description: '32 x 400GbE QSFP-DD/QSFP+/QSFP28 and 2 x 10GbE SFP+',
        portGroups: [
            { count: 32, suffix: 'et', speeds: ['40G', '100G', '400G'] },
            { count: 2, suffix: 'xe', speeds: ['10G'] },
        ],
    },
    {
        model: 'QFX5130-48C',
        label: 'QFX5130-48C',
        description: '48 x 100GbE SFP56-DD and 8 x 400GbE QSFP-DD',
        portGroups: [
            { count: 48, suffix: 'et', speeds: ['100G'] },
            { count: 8, suffix: 'et', speeds: ['400G'] },
        ],
    },
    {
        model: 'QFX5130-48CM',
        label: 'QFX5130-48CM',
        description: '48 x 100GbE SFP56-DD and 8 x 400GbE QSFP-DD',
        portGroups: [
            { count: 48, suffix: 'et', speeds: ['100G'] },
            { count: 8, suffix: 'et', speeds: ['400G'] },
        ],
    },
    {
        model: 'QFX5220-32CD',
        label: 'QFX5220-32CD',
        description: '32 x 40/100/400GbE QSFP56-DD and 2 x 10GbE SFP+',
        portGroups: [
            { count: 32, suffix: 'et', speeds: ['40G', '100G', '400G'] },
            { count: 2, suffix: 'xe', speeds: ['10G'] },
        ],
    },
    {
        model: 'QFX5220-128C',
        label: 'QFX5220-128C',
        description: '128 x 100GbE QSFP28 and 2 x 10GbE SFP+',
        portGroups: [
            { count: 128, suffix: 'et', speeds: ['100G'] },
            { count: 2, suffix: 'xe', speeds: ['10G'] },
        ],
    },
    {
        model: 'QFX5240-64QD',
        label: 'QFX5240-64QD',
        description: '64 x 800GbE QSFP-DD (breakout capable)',
        portGroups: [{ count: 64, suffix: 'et', speeds: ['100G', '400G', '800G'] }],
    },
    {
        model: 'QFX5240-64OD',
        label: 'QFX5240-64OD',
        description: '64 x 800GbE OSFP (breakout capable)',
        portGroups: [{ count: 64, suffix: 'et', speeds: ['50G', '100G', '400G', '800G'] }],
    },
    {
        model: 'QFX5241-32OD',
        label: 'QFX5241-32OD',
        description: '32 x 800GbE OSFP (breakout capable)',
        portGroups: [{ count: 32, suffix: 'et', speeds: ['50G', '100G', '400G', '800G'] }],
    },
]

const QFX_MODEL_PROFILE_BY_KEY = new Map(
    QFX_MODEL_PROFILES.map(p => [p.model.trim().toLowerCase(), p] as const),
)

// ─── Generic vendor port group / model profile types ──────────────────────────

interface VendorPortGroup { count: number; suffix: string; speeds: PortSpeed[] }
interface VendorModelProfile { model: string; label: string; description: string; portGroups: VendorPortGroup[] }

const VENDOR_DEVICE_FAMILIES: Record<string, SwitchFamily[]> = {
    juniper:  ['QFX', 'EX', 'MX', 'PTX', 'PTX-EVO', 'ACX'],
    cisco:    ['Catalyst', 'Nexus', 'ISR', 'ASR'],
    arista:   ['7050X', '7060X', '7280R', '7500R', '720XP'],
    nokia:    ['7220-IXR', '7250-IXR', '7750-SR'],
    sonic:    ['Edgecore', 'Celestica', 'SONiC-Dell'],
    hpe:      ['Aruba-CX', 'FlexNetwork'],
    huawei:   ['CloudEngine', 'NetEngine', 'S-Series'],
    dell:     ['S-PowerSwitch', 'Z-PowerSwitch', 'N-PowerSwitch'],
    mikrotik: ['CRS', 'CCR', 'RB'],
    extreme:  ['ExtremeSwitching', 'SLX', 'VSP'],
}

const ALL_SWITCH_FAMILIES = new Set<string>(Object.values(VENDOR_DEVICE_FAMILIES).flat())

const VENDOR_MODEL_PROFILES_MAP: Record<string, VendorModelProfile[]> = {
    'cisco:Catalyst': [
        { model: 'C9200-48P', label: 'C9200-48P', description: '48 x 1GbE PoE+ and 4 x 10GbE SFP+', portGroups: [{ count: 48, suffix: 'Gi', speeds: ['1G'] }, { count: 4, suffix: 'Te', speeds: ['10G'] }] },
        { model: 'C9300-48T', label: 'C9300-48T', description: '48 x 1GbE and 4 x 10G/25G SFP28', portGroups: [{ count: 48, suffix: 'Gi', speeds: ['1G'] }, { count: 4, suffix: 'Tw', speeds: ['10G', '25G'] }] },
        { model: 'C9300-48UXM', label: 'C9300-48UXM', description: '24 x mGig + 24 x 1GbE and 4 x 10G/25G', portGroups: [{ count: 48, suffix: 'Tw', speeds: ['1G', '2.5G', '5G', '10G'] }, { count: 4, suffix: 'Tw', speeds: ['10G', '25G'] }] },
        { model: 'C9500-48Y4C', label: 'C9500-48Y4C', description: '48 x 1/10/25GbE SFP28 and 4 x 100GbE QSFP28', portGroups: [{ count: 48, suffix: 'Tw', speeds: ['1G', '10G', '25G'] }, { count: 4, suffix: 'Hu', speeds: ['40G', '100G'] }] },
    ],
    'cisco:Nexus': [
        { model: 'N9K-C9332C', label: 'N9K-C9332C', description: '32 x 100GbE QSFP28 and 2 x 10GbE SFP+', portGroups: [{ count: 32, suffix: 'Hu', speeds: ['40G', '100G'] }, { count: 2, suffix: 'Te', speeds: ['10G'] }] },
        { model: 'N9K-C9336C-FX2', label: 'N9K-C9336C-FX2', description: '36 x 40/100GbE QSFP28', portGroups: [{ count: 36, suffix: 'Hu', speeds: ['40G', '100G'] }] },
        { model: 'N9K-C93180YC-FX', label: 'N9K-C93180YC-FX', description: '48 x 1/10/25GbE SFP+ and 6 x 100GbE QSFP28', portGroups: [{ count: 48, suffix: 'Tw', speeds: ['1G', '10G', '25G'] }, { count: 6, suffix: 'Hu', speeds: ['40G', '100G'] }] },
        { model: 'N9K-C93360YC-FX2', label: 'N9K-C93360YC-FX2', description: '96 x 25GbE SFP28 and 12 x 100GbE QSFP28', portGroups: [{ count: 96, suffix: 'Tw', speeds: ['1G', '10G', '25G'] }, { count: 12, suffix: 'Hu', speeds: ['40G', '100G'] }] },
    ],
    'cisco:ISR': [
        { model: 'ISR-4221', label: 'ISR 4221', description: '2 x 1GbE WAN + 2 x 1GbE LAN', portGroups: [{ count: 4, suffix: 'Gi', speeds: ['1G'] }] },
        { model: 'ISR-4331', label: 'ISR 4331', description: '3 x 1GbE + 2 x NIM slots', portGroups: [{ count: 3, suffix: 'Gi', speeds: ['1G'] }] },
        { model: 'ISR-4461', label: 'ISR 4461', description: '4 x 1GbE + 4 x 10GbE', portGroups: [{ count: 4, suffix: 'Gi', speeds: ['1G'] }, { count: 4, suffix: 'Te', speeds: ['10G'] }] },
    ],
    'cisco:ASR': [
        { model: 'ASR-1001-X', label: 'ASR 1001-X', description: '6 x 1GbE SFP and 2 x 10GbE SFP+', portGroups: [{ count: 6, suffix: 'Gi', speeds: ['1G'] }, { count: 2, suffix: 'Te', speeds: ['10G'] }] },
        { model: 'ASR-9001', label: 'ASR 9001', description: '4 x 10GbE SFP+ and 2 x 100GbE CFP', portGroups: [{ count: 4, suffix: 'Te', speeds: ['10G'] }, { count: 2, suffix: 'Hu', speeds: ['100G'] }] },
        { model: 'ASR-9901', label: 'ASR 9901', description: '24 x 100GbE QSFP28', portGroups: [{ count: 24, suffix: 'Hu', speeds: ['100G'] }] },
    ],
    'arista:7050X': [
        { model: '7050CX3-32S', label: 'DCS-7050CX3-32S', description: '32 x 100GbE QSFP and 2 x 10GbE SFP+', portGroups: [{ count: 32, suffix: 'Ethernet', speeds: ['40G', '100G'] }, { count: 2, suffix: 'Ethernet', speeds: ['10G'] }] },
        { model: '7050SX3-48YC12', label: 'DCS-7050SX3-48YC12', description: '48 x 25GbE SFP28 and 12 x 100GbE QSFP', portGroups: [{ count: 48, suffix: 'Ethernet', speeds: ['1G', '10G', '25G'] }, { count: 12, suffix: 'Ethernet', speeds: ['40G', '100G'] }] },
    ],
    'arista:7060X': [
        { model: '7060CX2-32S', label: 'DCS-7060CX2-32S', description: '32 x 100GbE QSFP and 2 x 10GbE SFP+', portGroups: [{ count: 32, suffix: 'Ethernet', speeds: ['40G', '100G'] }, { count: 2, suffix: 'Ethernet', speeds: ['10G'] }] },
        { model: '7060DX5-32', label: 'DCS-7060DX5-32', description: '32 x 400GbE QSFP-DD', portGroups: [{ count: 32, suffix: 'Ethernet', speeds: ['100G', '400G'] }] },
    ],
    'arista:7280R': [
        { model: '7280R3', label: 'DCS-7280R3', description: '48 x 25GbE SFP28 and 8 x 100GbE QSFP', portGroups: [{ count: 48, suffix: 'Ethernet', speeds: ['10G', '25G'] }, { count: 8, suffix: 'Ethernet', speeds: ['100G'] }] },
        { model: '7280CR3-32P4', label: 'DCS-7280CR3-32P4', description: '32 x 100GbE and 4 x 400GbE QSFP-DD', portGroups: [{ count: 32, suffix: 'Ethernet', speeds: ['100G'] }, { count: 4, suffix: 'Ethernet', speeds: ['400G'] }] },
    ],
    'arista:7500R': [
        { model: '7504R3', label: 'DCS-7504R3', description: 'Modular — up to 288 x 100GbE', portGroups: [{ count: 288, suffix: 'Ethernet', speeds: ['100G'] }] },
    ],
    'arista:720XP': [
        { model: '720XP-24Y6', label: 'DCS-720XP-24Y6', description: '24 x 25GbE SFP28 and 6 x 100GbE QSFP', portGroups: [{ count: 24, suffix: 'Ethernet', speeds: ['1G', '10G', '25G'] }, { count: 6, suffix: 'Ethernet', speeds: ['100G'] }] },
        { model: '720XP-48ZC2', label: 'DCS-720XP-48ZC2', description: '48 x 10GbE SFP+ and 2 x 100GbE QSFP', portGroups: [{ count: 48, suffix: 'Ethernet', speeds: ['1G', '10G'] }, { count: 2, suffix: 'Ethernet', speeds: ['100G'] }] },
    ],
    'nokia:7220-IXR': [
        { model: 'IXR-D2', label: '7220 IXR-D2', description: '48 x 25GbE SFP28 and 8 x 100GbE QSFP28', portGroups: [{ count: 48, suffix: 'ethernet', speeds: ['1G', '10G', '25G'] }, { count: 8, suffix: 'ethernet', speeds: ['100G'] }] },
        { model: 'IXR-D3', label: '7220 IXR-D3', description: '32 x 100GbE QSFP28 and 2 x 10GbE SFP+', portGroups: [{ count: 32, suffix: 'ethernet', speeds: ['40G', '100G'] }, { count: 2, suffix: 'ethernet', speeds: ['10G'] }] },
        { model: 'IXR-H3', label: '7220 IXR-H3', description: '36 x 400GbE QSFP-DD', portGroups: [{ count: 36, suffix: 'ethernet', speeds: ['100G', '400G'] }] },
    ],
    'nokia:7250-IXR': [
        { model: 'IXR-6e', label: '7250 IXR-6e', description: '6-slot modular — up to 36 x 100GbE', portGroups: [{ count: 36, suffix: 'ethernet', speeds: ['100G'] }] },
        { model: 'IXR-10e', label: '7250 IXR-10e', description: '10-slot modular — up to 60 x 100GbE', portGroups: [{ count: 60, suffix: 'ethernet', speeds: ['100G'] }] },
        { model: 'IXR-X1', label: '7250 IXR-X1', description: '36 x 400GbE QSFP-DD', portGroups: [{ count: 36, suffix: 'ethernet', speeds: ['100G', '400G'] }] },
    ],
    'nokia:7750-SR': [
        { model: 'SR-1', label: '7750 SR-1', description: '36 x 100GbE QSFP28 (fixed)', portGroups: [{ count: 36, suffix: 'ethernet', speeds: ['10G', '100G'] }] },
        { model: 'SR-1s', label: '7750 SR-1s', description: '36 x 100GbE QSFP28 (fixed)', portGroups: [{ count: 36, suffix: 'ethernet', speeds: ['10G', '100G'] }] },
    ],
    'sonic:Edgecore': [
        { model: 'AS7726-32X', label: 'AS7726-32X', description: '32 x 100GbE QSFP28 and 2 x 10GbE SFP+', portGroups: [{ count: 32, suffix: 'Ethernet', speeds: ['40G', '100G'] }, { count: 2, suffix: 'Ethernet', speeds: ['10G'] }] },
        { model: 'AS7326-56X', label: 'AS7326-56X', description: '48 x 25GbE SFP28 and 8 x 100GbE QSFP28', portGroups: [{ count: 48, suffix: 'Ethernet', speeds: ['1G', '10G', '25G'] }, { count: 8, suffix: 'Ethernet', speeds: ['100G'] }] },
        { model: 'AS9516-32D', label: 'AS9516-32D', description: '32 x 400GbE QSFP-DD', portGroups: [{ count: 32, suffix: 'Ethernet', speeds: ['100G', '400G'] }] },
    ],
    'sonic:Celestica': [
        { model: 'DS3000', label: 'DS3000', description: '32 x 100GbE QSFP28', portGroups: [{ count: 32, suffix: 'Ethernet', speeds: ['40G', '100G'] }] },
        { model: 'DS4000', label: 'DS4000', description: '32 x 400GbE QSFP-DD', portGroups: [{ count: 32, suffix: 'Ethernet', speeds: ['100G', '400G'] }] },
    ],
    'sonic:SONiC-Dell': [
        { model: 'Z9264F-ON', label: 'Z9264F-ON (SONiC)', description: '64 x 100GbE QSFP28', portGroups: [{ count: 64, suffix: 'Ethernet', speeds: ['100G'] }] },
        { model: 'Z9332F-ON', label: 'Z9332F-ON (SONiC)', description: '32 x 400GbE QSFP-DD and 2 x 10GbE SFP+', portGroups: [{ count: 32, suffix: 'Ethernet', speeds: ['100G', '400G'] }, { count: 2, suffix: 'Ethernet', speeds: ['10G'] }] },
    ],
    'hpe:Aruba-CX': [
        { model: 'CX6200F-48G', label: 'CX 6200F-48G', description: '48 x 1GbE and 4 x 10GbE SFP+', portGroups: [{ count: 48, suffix: '', speeds: ['1G'] }, { count: 4, suffix: '', speeds: ['10G'] }] },
        { model: 'CX6300M-48G', label: 'CX 6300M-48G', description: '48 x 1GbE and 4 x 25GbE SFP28', portGroups: [{ count: 48, suffix: '', speeds: ['1G'] }, { count: 4, suffix: '', speeds: ['10G', '25G'] }] },
        { model: 'CX8360-32Y4C', label: 'CX 8360-32Y4C', description: '32 x 25GbE SFP28 and 4 x 100GbE QSFP28', portGroups: [{ count: 32, suffix: '', speeds: ['1G', '10G', '25G'] }, { count: 4, suffix: '', speeds: ['100G'] }] },
        { model: 'CX10000-48Y6C', label: 'CX 10000-48Y6C', description: '48 x 25GbE SFP28 and 6 x 100GbE QSFP28', portGroups: [{ count: 48, suffix: '', speeds: ['1G', '10G', '25G'] }, { count: 6, suffix: '', speeds: ['100G'] }] },
    ],
    'hpe:FlexNetwork': [
        { model: '5130-48G', label: '5130-48G-PoE+', description: '48 x 1GbE PoE+ and 4 x 10GbE SFP+', portGroups: [{ count: 48, suffix: '', speeds: ['1G'] }, { count: 4, suffix: '', speeds: ['10G'] }] },
        { model: '5510-48G', label: '5510-48G-PoE+', description: '48 x 1GbE PoE+ and 4 x 10GbE SFP+', portGroups: [{ count: 48, suffix: '', speeds: ['1G'] }, { count: 4, suffix: '', speeds: ['10G'] }] },
    ],
    'huawei:CloudEngine': [
        { model: 'CE6850-48S6Q', label: 'CE6850-48S6Q', description: '48 x 10GbE SFP+ and 6 x 40GbE QSFP+', portGroups: [{ count: 48, suffix: '10GE', speeds: ['10G'] }, { count: 6, suffix: '40GE', speeds: ['40G'] }] },
        { model: 'CE6860-48S8CQ', label: 'CE6860-48S8CQ', description: '48 x 25GbE SFP28 and 8 x 100GbE QSFP28', portGroups: [{ count: 48, suffix: '25GE', speeds: ['10G', '25G'] }, { count: 8, suffix: '100GE', speeds: ['100G'] }] },
        { model: 'CE8850-64CQ', label: 'CE8850-64CQ', description: '64 x 100GbE QSFP28', portGroups: [{ count: 64, suffix: '100GE', speeds: ['100G'] }] },
    ],
    'huawei:NetEngine': [
        { model: 'NE40E', label: 'NE40E', description: 'Modular — up to 24 x 10GbE', portGroups: [{ count: 24, suffix: '10GE', speeds: ['10G'] }] },
        { model: 'NE8000-F1A', label: 'NE8000-F1A', description: '36 x 100GbE QSFP28', portGroups: [{ count: 36, suffix: '100GE', speeds: ['100G'] }] },
    ],
    'huawei:S-Series': [
        { model: 'S5735-L48T4X', label: 'S5735-L48T4X', description: '48 x 1GbE and 4 x 10GbE SFP+', portGroups: [{ count: 48, suffix: 'GigabitEthernet', speeds: ['1G'] }, { count: 4, suffix: '10GE', speeds: ['10G'] }] },
        { model: 'S6730-H48X6C', label: 'S6730-H48X6C', description: '48 x 10GbE SFP+ and 6 x 100GbE QSFP28', portGroups: [{ count: 48, suffix: '10GE', speeds: ['10G'] }, { count: 6, suffix: '100GE', speeds: ['100G'] }] },
    ],
    'dell:S-PowerSwitch': [
        { model: 'S5248F-ON', label: 'S5248F-ON', description: '48 x 25GbE SFP28 and 6 x 100GbE QSFP28', portGroups: [{ count: 48, suffix: 'ethernet', speeds: ['10G', '25G'] }, { count: 6, suffix: 'ethernet', speeds: ['100G'] }] },
        { model: 'S5296F-ON', label: 'S5296F-ON', description: '96 x 25GbE SFP28 and 8 x 100GbE QSFP28', portGroups: [{ count: 96, suffix: 'ethernet', speeds: ['10G', '25G'] }, { count: 8, suffix: 'ethernet', speeds: ['100G'] }] },
    ],
    'dell:Z-PowerSwitch': [
        { model: 'Z9264F-ON', label: 'Z9264F-ON', description: '64 x 100GbE QSFP28', portGroups: [{ count: 64, suffix: 'ethernet', speeds: ['100G'] }] },
        { model: 'Z9332F-ON', label: 'Z9332F-ON', description: '32 x 400GbE QSFP-DD and 2 x 10GbE SFP+', portGroups: [{ count: 32, suffix: 'ethernet', speeds: ['100G', '400G'] }, { count: 2, suffix: 'ethernet', speeds: ['10G'] }] },
    ],
    'dell:N-PowerSwitch': [
        { model: 'N3248TE-ON', label: 'N3248TE-ON', description: '48 x 1GbE and 4 x 10GbE SFP+', portGroups: [{ count: 48, suffix: 'ethernet', speeds: ['1G'] }, { count: 4, suffix: 'ethernet', speeds: ['10G'] }] },
    ],
    'mikrotik:CRS': [
        { model: 'CRS326-24G-2S+', label: 'CRS326-24G-2S+', description: '24 x 1GbE and 2 x 10GbE SFP+', portGroups: [{ count: 24, suffix: 'ether', speeds: ['1G'] }, { count: 2, suffix: 'sfp-sfpplus', speeds: ['10G'] }] },
        { model: 'CRS328-24P-4S+', label: 'CRS328-24P-4S+', description: '24 x 1GbE PoE and 4 x 10GbE SFP+', portGroups: [{ count: 24, suffix: 'ether', speeds: ['1G'] }, { count: 4, suffix: 'sfp-sfpplus', speeds: ['10G'] }] },
        { model: 'CRS354-48G-4S+2Q+', label: 'CRS354-48G-4S+2Q+', description: '48 x 1GbE, 4 x 10GbE SFP+, 2 x 40GbE QSFP+', portGroups: [{ count: 48, suffix: 'ether', speeds: ['1G'] }, { count: 4, suffix: 'sfp-sfpplus', speeds: ['10G'] }, { count: 2, suffix: 'qsfpplus', speeds: ['40G'] }] },
    ],
    'mikrotik:CCR': [
        { model: 'CCR2004-1G-12S+2XS', label: 'CCR2004-1G-12S+2XS', description: '1 x 1GbE, 12 x 10GbE SFP+, 2 x 25GbE SFP28', portGroups: [{ count: 1, suffix: 'ether', speeds: ['1G'] }, { count: 12, suffix: 'sfp-sfpplus', speeds: ['10G'] }, { count: 2, suffix: 'sfp28', speeds: ['25G'] }] },
        { model: 'CCR2116-12G-4S+', label: 'CCR2116-12G-4S+', description: '12 x 1GbE and 4 x 10GbE SFP+', portGroups: [{ count: 12, suffix: 'ether', speeds: ['1G'] }, { count: 4, suffix: 'sfp-sfpplus', speeds: ['10G'] }] },
    ],
    'mikrotik:RB': [
        { model: 'RB5009UG+S+IN', label: 'RB5009UG+S+IN', description: '7 x 1GbE, 1 x 2.5GbE, 1 x 10GbE SFP+', portGroups: [{ count: 7, suffix: 'ether', speeds: ['1G'] }, { count: 1, suffix: 'ether', speeds: ['2.5G'] }, { count: 1, suffix: 'sfp-sfpplus', speeds: ['10G'] }] },
    ],
    'extreme:ExtremeSwitching': [
        { model: 'X465-24MU', label: 'X465-24MU', description: '24 x mGig, 4 x 10GbE SFP+, 2 x 25GbE SFP28', portGroups: [{ count: 24, suffix: '1:', speeds: ['1G', '2.5G', '5G', '10G'] }, { count: 4, suffix: '1:', speeds: ['10G'] }, { count: 2, suffix: '1:', speeds: ['25G'] }] },
        { model: 'X465-48T', label: 'X465-48T', description: '48 x 1GbE, 4 x 10GbE SFP+, 2 x 25GbE SFP28', portGroups: [{ count: 48, suffix: '1:', speeds: ['1G'] }, { count: 4, suffix: '1:', speeds: ['10G'] }, { count: 2, suffix: '1:', speeds: ['25G'] }] },
        { model: 'X695-48Y-8C', label: 'X695-48Y-8C', description: '48 x 25GbE SFP28 and 8 x 100GbE QSFP28', portGroups: [{ count: 48, suffix: '1:', speeds: ['10G', '25G'] }, { count: 8, suffix: '1:', speeds: ['100G'] }] },
    ],
    'extreme:SLX': [
        { model: 'SLX-9640', label: 'SLX 9640', description: '36 x 100GbE QSFP28', portGroups: [{ count: 36, suffix: '1:', speeds: ['40G', '100G'] }] },
        { model: 'SLX-9740', label: 'SLX 9740', description: '32 x 400GbE QSFP-DD', portGroups: [{ count: 32, suffix: '1:', speeds: ['100G', '400G'] }] },
    ],
    'extreme:VSP': [
        { model: 'VSP-4900-48P', label: 'VSP 4900-48P', description: '48 x 1GbE PoE+ and 4 x 10GbE SFP+', portGroups: [{ count: 48, suffix: '1:', speeds: ['1G'] }, { count: 4, suffix: '1:', speeds: ['10G'] }] },
        { model: 'VSP-7400-48Y-8C', label: 'VSP 7400-48Y-8C', description: '48 x 25GbE SFP28 and 8 x 100GbE QSFP28', portGroups: [{ count: 48, suffix: '1:', speeds: ['10G', '25G'] }, { count: 8, suffix: '1:', speeds: ['100G'] }] },
    ],
}

// Add QFX profiles to generic map (keeps backward compatibility with Juniper-specific code paths)
VENDOR_MODEL_PROFILES_MAP['juniper:QFX'] = QFX_MODEL_PROFILES.map(p => ({
    model: p.model, label: p.label, description: p.description,
    portGroups: p.portGroups.map(g => ({ count: g.count, suffix: g.suffix, speeds: [...g.speeds] })),
}))

// Vendors using continuous port index across all groups vs per-group numbering
const CONTINUOUS_INDEX_VENDORS = new Set(['juniper', 'arista', 'sonic', 'dell', 'hpe', 'extreme', 'nokia'])

// ─── Role tier map (matches topology.service.ts) ─────────────────────────────
const ROLE_TIER: Record<string, number> = {
    'super-spine': 0, spine: 1, leaf: 2, 'border-leaf': 2,
    tor: 3, access: 3, aggregation: 1, core: 0, gateway: 0, custom: 3,
}

// ─── Node properties enhancement interfaces ──────────────────────────────────

interface DetectedServiceProfile {
    profileId: string
    profileName: string
    profileIcon: string
    matchedPorts: number
    totalRulePorts: number
}

interface PortDiagramCell {
    portId: string
    label: string
    color: string
    borderColor: string
    tooltip: string
    linked: boolean
    enabled: boolean
    vlanMode: 'access' | 'trunk' | undefined
}

interface PeerConnection {
    peerId: string
    peerLabel: string
    peerRole: string
    peerRoleColor: string
    links: PeerLinkDetail[]
}

interface PeerLinkDetail {
    linkId: string
    localPortId: string
    localPortLabel: string
    remotePortId: string
    remotePortLabel: string
    linkStatus: 'up' | 'down' | undefined
    vlanMode: 'access' | 'trunk' | undefined
}

@Component({
    selector: 'node-properties',
    templateUrl: './node-properties.component.pug',
    styleUrls: ['./node-properties.component.scss'],
    changeDetection: ChangeDetectionStrategy.OnPush,
})
export class NodePropertiesComponent implements OnInit, OnChanges, OnDestroy {

    @Input() nodeId: string | null = null
    @Input() clabContainers: Array<{ name: string; state: string; kind: string }> = []
    @Input() clabDeployed = false
    @Input() clabServers: Array<{ id: string; name: string; type: 'local' | 'ssh'; host?: string }> = []
    @Input() localDockerImages: string[] = []
    @Input() activeServerId = 'local'
    @Output() closed = new EventEmitter<void>()

    node: TopologyNode | null = null
    activeTab: PanelTab = 'info'

    private _backendSvc: any = null

    /** Cached device inventory used as a credential fallback when the node's
     *  Info-tab SSH fields are empty. Loaded lazily on first need and refreshed
     *  on each node change. Stored as `[]` if unavailable. */
    private _inventoryCache: import('../services/inventory-creds').InventoryRecord[] | null = null
    private async _ensureInventoryLoaded (): Promise<void> {
        if (this._inventoryCache != null) { return }
        this._inventoryCache = await loadDeviceInventory()
        this.cdr.markForCheck()
    }
    /** Resolve SSH creds for the current node — node fields, then inventory. */
    private _resolveCreds (): { username: string; password: string; source: 'node'|'inventory'|'none'; matchedHostname?: string } {
        if (!this.node) { return { username: '', password: '', source: 'none' } }
        return resolveSshCredentials(this.node, this._inventoryCache ?? [])
    }
    private _getBackendSvc (): any {
        if (!this._backendSvc) {
            try { this._backendSvc = new (require('../services/backend-client.service').BackendClientService)() } catch {}
        }
        return this._backendSvc
    }

    // Local draft — edits are applied on blur / Enter / explicit save
    draft: Partial<TopologyNode> = {}
    portDrafts: Record<string, Partial<NodePort>> = {}
    portChannelDrafts: Record<string, number> = {}

    // ── Staging tab buffers (per-node Day-0 overrides) ──
    // Comma-separated text inputs that get parsed to string[] on apply.
    stagingNtpServersText = ''
    stagingSyslogServersText = ''
    stagingDnsServersText = ''
    stagingSnmpTrapTargetsText = ''
    // Single-field overrides bound directly via ngModel
    stagingSnmpCommunity = ''
    stagingSnmpContact = ''
    stagingSnmpLocation = ''
    stagingBannerLogin = ''
    stagingMsg = ''

    // VLAN table draft state
    vlanDrafts: VlanDefinition[] = []
    newVlanId: number | null = null
    newVlanName = ''

    // VLAN auto-generate state
    vlanGenStart: number | null = null
    vlanGenEnd: number | null = null
    vlanGenPrefix = 'VLAN'
    vlanGenStep = 1

    // VLAN template picker state
    showVlanTemplates = false
    vlanTemplateFilter: 'all' | VlanTemplateCategory = 'all'
    readonly vlanTemplates = VLAN_TEMPLATES
    readonly vlanTemplateCategories: { id: 'all' | VlanTemplateCategory; label: string }[] = [
        { id: 'all',              label: 'All' },
        { id: 'datacenter',      label: 'Datacenter' },
        { id: 'enterprise',      label: 'Enterprise' },
        { id: 'service-provider', label: 'Service Provider' },
    ]

    readonly ramPresets = RAM_PRESETS
    readonly speedPresets = PORT_SPEED_PRESETS
    readonly meta: Record<string, NodeTypeMeta> = NODE_TYPE_META
    readonly switchFamilyOptions: SwitchFamily[] = ['QFX', 'EX']
    readonly qfxModelProfiles: QfxModelProfile[] = QFX_MODEL_PROFILES
    readonly vendorOptions = [
        'Cisco',
        'Juniper',
        'Arista',
        'SONiC',
        'Nokia',
        'HPE',
        'Huawei',
        'Dell',
        'MikroTik',
        'Extreme',
    ]

    // Linked port info (which links are connected to each port)
    portLinkMap: Record<string, string> = {}   // portId → "NodeLabel (portLabel)"
    sshBusy = false
    sshStatusOk = false
    sshStatusMsg = ''
    sshOutput = ''
    sshPassword = ''
    portGenMsg = ''

    // Service profile detection
    detectedProfile: DetectedServiceProfile | null = null
    showServiceSection = true

    // Port diagram
    portDiagram: PortDiagramCell[] = []

    // Connection map (Links tab)
    peerConnections: PeerConnection[] = []

    // Config snippet library
    snippets: ConfigSnippet[] = []
    showSnippetLibrary = false
    snippetFilter: SnippetCategory | 'all' = 'all'
    snippetSearch = ''
    savingSnippetName = ''
    savingSnippetCategory: SnippetCategory = 'custom'

    @Output() nodeSelected = new EventEmitter<string>()

    private _subs: Subscription[] = []

    constructor (
        private svc: TopologyService,
        public invSvc: InventoryService,
        private cdr: ChangeDetectorRef,
    ) {}

    ngOnInit (): void {
        this._subs.push(
            this.svc.topology$.subscribe(() => {
                this._loadNode()
                this.cdr.detectChanges()
            }),
            // Re-render when inventory store updates (e.g. sidecar loaded after topology)
            this.invSvc.store$.subscribe(() => {
                this.cdr.markForCheck()
            }),
        )
    }

    ngOnChanges (changes: SimpleChanges): void {
        if (changes['nodeId']) {
            this.activeTab = 'info'
            this.pollSyncProposal = null
            this.proposalChecked = {}
            this._loadNode()
        }
        // Re-fetch host interfaces when active server changes
        if (changes['activeServerId']) {
            if (this.isHostNode) {
                this.hostInterfaces = []
                this.fetchHostInterfaces()
            }
            if (this.isBridgeNode) {
                this.bridgeListForNode = []
                this.fetchBridgeList()
            }
        }
    }

    ngOnDestroy (): void { this._subs.forEach(s => s.unsubscribe()) }

    private _loadNode (): void {
        if (!this.nodeId) { this.node = null; return }
        this.node = this.svc.getNode(this.nodeId) ?? null
        if (!this.node) { return }
        const inferredSwitchFamily = this._inferSwitchFamily(this.node.switchFamily, this.node.model)

        // Sync draft with current node values
        this.draft = {
            label:         this.node.label,
            description:   this.node.description ?? '',
            ram:           this.node.ram ?? 256,
            image:         this.node.image ?? '',
            vendor:        this.node.vendor ?? '',
            switchFamily:  inferredSwitchFamily || undefined,
            model:         this.node.model ?? '',
            desiredPortCount: this.node.desiredPortCount ?? this.node.ports.length,
            portSuffix:    this.node.portSuffix ?? '',
            operatingSpeed: this.node.operatingSpeed,
            asn:           this.node.asn,
            ospfArea:      this.node.ospfArea,
            isisLevel:     this.node.isisLevel,
            nodeSid:       this.node.nodeSid,
            srv6Locator:   this.node.srv6Locator ?? '',
            mplsLdp:       this.node.mplsLdp,
            mgmtIp:        this.node.mgmtIp ?? '',
            loopbackIp:    this.node.loopbackIp ?? '',
            loopbackIpv6:  this.node.loopbackIpv6 ?? '',
            sshPort:       this.node.sshPort ?? 22,
            sshUsername:   this.node.sshUsername ?? '',
            sshPassword:   this.node.sshPassword ?? '',
            startupConfig: this.node.startupConfig ?? '',
            staging:       (this.node as any).staging ?? undefined,
            notes:         this.node.notes ?? '',
            serialNumber:  this.node.serialNumber ?? '',
            sourceId:      this.node.sourceId ?? '',
            pollMethod:    this.node.pollMethod,
            snmpVersion:   this.node.snmpVersion ?? '2c',
            snmpCommunity: this.node.snmpCommunity ?? 'public',
            snmpPort:      this.node.snmpPort ?? 161,
            snmpAuthProtocol: this.node.snmpAuthProtocol,
            snmpAuthPassword: this.node.snmpAuthPassword ?? '',
            snmpPrivProtocol: this.node.snmpPrivProtocol,
            snmpPrivPassword: this.node.snmpPrivPassword ?? '',
            hostInterface: this.node.hostInterface ?? '',
            bridgeName: this.node.bridgeName ?? '',
            bridgeType: this.node.bridgeType ?? 'linux',
            serverId: this.node.serverId,
        }

        // Sync staging override buffers from node (per-node staging)
        const ns: any = (this.node as any).staging ?? {}
        this.stagingNtpServersText      = (ns.ntp?.servers ?? []).join(', ')
        this.stagingSyslogServersText   = (ns.syslog?.servers ?? []).join(', ')
        this.stagingDnsServersText      = (ns.dns?.servers ?? []).join(', ')
        this.stagingSnmpTrapTargetsText = (ns.snmp?.trapTargets ?? []).join(', ')
        this.stagingSnmpCommunity       = ns.snmp?.community ?? ''
        this.stagingSnmpContact         = ns.snmp?.contact ?? ''
        this.stagingSnmpLocation        = ns.snmp?.location ?? ''
        this.stagingBannerLogin         = ns.banner?.login ?? ''
        this.stagingMsg                 = ''

        // Auto-fetch host interfaces when selecting a host port node
        if (this.node.type === 'host' && !this.hostInterfaces.length) {
            // Auto-populate ports if the node has a serverId and no real interface names yet
            const hasRealPorts = this.node.ports.some(p => p.label && p.label !== 'NIC' && !/^NIC\d+$/.test(p.label))
            this.fetchHostInterfaces(this.node.serverId ? !hasRealPorts : false)
        }
        // Auto-fetch bridge list when selecting a bridge node
        if (this.node.type === 'bridge' && !this.bridgeListForNode.length) {
            this.fetchBridgeList()
        }
        this.sshBusy = false
        this.sshStatusOk = false
        this.sshStatusMsg = ''
        this.sshOutput = ''
        this.sshPassword = this.node.sshPassword ?? ''
        this.portGenMsg = ''

        // Lazy-load the device inventory so push buttons can fall back to
        // inventory credentials when the Info-tab fields are empty.
        this._ensureInventoryLoaded()

        // Sync per-port drafts
        this.portDrafts = {}
        this.portChannelDrafts = {}
        const channelCounts = new Map<string, number>()
        for (const p of this.node.ports) {
            const sep = p.label.indexOf(':')
            if (sep > 0) {
                const base = p.label.slice(0, sep)
                channelCounts.set(base, (channelCounts.get(base) ?? 0) + 1)
            }
        }
        for (const p of this.node.ports) {
            this.portDrafts[p.id] = {
                label:       p.label,
                ipAddress:   p.ipAddress ?? '',
                ipv6Address: p.ipv6Address ?? '',
                description: p.description ?? '',
                enabled:     p.enabled,
                speed:       p.speed,
                vlan:        p.vlan,
                vlanMode:    p.vlanMode,
                trunkNativeVlan:  p.trunkNativeVlan,
                trunkAllowedVlans: p.trunkAllowedVlans ?? '',
            }
            const sep = p.label.indexOf(':')
            if (sep > 0) {
                const base = p.label.slice(0, sep)
                this.portChannelDrafts[p.id] = channelCounts.get(base) ?? 0
            } else {
                this.portChannelDrafts[p.id] = 0
            }
        }

        // Load VLAN table
        this.vlanDrafts = (this.node.vlans ?? []).map(v => ({ ...v }))
        this.newVlanId = null
        this.newVlanName = ''
        this.vlanGenStart = null
        this.vlanGenEnd = null
        this.vlanGenPrefix = 'VLAN'
        this.vlanGenStep = 1
        this.showVlanTemplates = false
        this.vlanTemplateFilter = 'all'

        // Build port → link label map
        this.portLinkMap = {}
        const topo = this.svc.topology
        for (const link of topo.links) {
            if (link.sourceNodeId === this.nodeId) {
                const tn = topo.nodes.find(n => n.id === link.targetNodeId)
                const tp = tn?.ports.find(p => p.id === link.targetPortId)
                this.portLinkMap[link.sourcePortId] =
                    `${tn?.label ?? '?'} (${tp?.label ?? '?'})`
            }
            if (link.targetNodeId === this.nodeId) {
                const sn = topo.nodes.find(n => n.id === link.sourceNodeId)
                const sp = sn?.ports.find(p => p.id === link.sourcePortId)
                this.portLinkMap[link.targetPortId] =
                    `${sn?.label ?? '?'} (${sp?.label ?? '?'})`
            }
        }

        // Compute enhancements
        this._detectServiceProfile(topo)
        this._buildPortDiagram()
        this._buildPeerConnections(topo)
    }

    // ── Service profile detection ────────────────────────────────────────────

    private _detectServiceProfile (topo: { nodes: TopologyNode[]; links: TopologyLink[] }): void {
        this.detectedProfile = null
        if (!this.node) { return }
        const nodeRole = this.node.role
        if (!nodeRole) { return }

        const connectedPortIds = new Set(Object.keys(this.portLinkMap))

        // Build portPeerRole map — for each connected port, the role of its peer node
        const portPeerRole = new Map<string, NodeRole>()
        for (const link of topo.links) {
            if (link.sourceNodeId === this.nodeId) {
                const peer = topo.nodes.find(n => n.id === link.targetNodeId)
                if (peer?.role) { portPeerRole.set(link.sourcePortId, peer.role) }
            }
            if (link.targetNodeId === this.nodeId) {
                const peer = topo.nodes.find(n => n.id === link.sourceNodeId)
                if (peer?.role) { portPeerRole.set(link.targetPortId, peer.role) }
            }
        }

        const myTier = ROLE_TIER[nodeRole] ?? 2
        let bestProfile: DetectedServiceProfile | null = null
        let bestRatio = 0

        for (const profile of SERVICE_PROFILES) {
            // Only consider profiles that have rules matching this node's role
            const matchingRules = profile.portRules.filter(r => r.roles.includes(nodeRole))
            if (matchingRules.length === 0) { continue }

            let matched = 0
            let total = 0

            for (const rule of matchingRules) {
                // Classify ports by scope
                const scopePorts: string[] = []
                for (const port of this.node!.ports) {
                    const isConnected = connectedPortIds.has(port.id)
                    if (rule.scope === 'free-ports' && !isConnected) {
                        scopePorts.push(port.id)
                    } else if (rule.scope === 'all-connected' && isConnected) {
                        scopePorts.push(port.id)
                    } else if (rule.scope === 'uplinks' && isConnected) {
                        const peerRole = portPeerRole.get(port.id)
                        const peerTier = peerRole ? (ROLE_TIER[peerRole] ?? 2) : myTier
                        if (peerTier < myTier) { scopePorts.push(port.id) }
                    } else if (rule.scope === 'downlinks' && isConnected) {
                        const peerRole = portPeerRole.get(port.id)
                        const peerTier = peerRole ? (ROLE_TIER[peerRole] ?? 2) : myTier
                        if (peerTier > myTier) { scopePorts.push(port.id) }
                    }
                }

                total += scopePorts.length

                // Check how many of these ports match the rule config
                for (const pid of scopePorts) {
                    const port = this.node!.ports.find(p => p.id === pid)
                    if (!port) { continue }
                    const modeMatch = (port.vlanMode ?? 'access') === rule.vlanMode
                    if (modeMatch) { matched++ }
                }
            }

            const ratio = total > 0 ? matched / total : 0
            if (ratio > bestRatio) {
                bestRatio = ratio
                bestProfile = {
                    profileId: profile.id,
                    profileName: profile.name,
                    profileIcon: profile.icon,
                    matchedPorts: matched,
                    totalRulePorts: total,
                }
            }
        }

        if (bestProfile && bestRatio >= 0.5) {
            this.detectedProfile = bestProfile
        }
    }

    // ── Port diagram ─────────────────────────────────────────────────────────

    private _buildPortDiagram (): void {
        this.portDiagram = []
        if (!this.node) { return }

        for (const port of this.node.ports) {
            const linked = port.id in this.portLinkMap
            const enabled = port.enabled !== false
            const vlanMode = port.vlanMode as ('access' | 'trunk' | undefined)

            // Fill color
            let color: string
            if (!enabled) {
                color = '#1a1a2e'
            } else if (linked) {
                color = '#22c55e'
            } else {
                color = '#374151'
            }

            // Border color based on VLAN mode
            let borderColor = '#2a3a50'
            if (vlanMode === 'trunk') {
                borderColor = '#3b82f6'
            } else if (vlanMode === 'access' && port.vlan) {
                borderColor = '#22c55e'
            }

            // Extract short label (remove common prefix patterns)
            let shortLabel = port.label
            const m = port.label.match(/(?:eth|Eth|Gi|ge|xe|et|Te|Fo|Hu|swp|e|p)\s*(.*)/)
            if (m) { shortLabel = m[1] }

            const peerInfo = this.portLinkMap[port.id]
            const tooltip = port.label + (peerInfo ? ` → ${peerInfo}` : ' (unlinked)')

            this.portDiagram.push({
                portId: port.id,
                label: shortLabel,
                color,
                borderColor,
                tooltip,
                linked,
                enabled,
                vlanMode,
            })
        }
    }

    // ── Peer connections (Links tab) ─────────────────────────────────────────

    private _buildPeerConnections (topo: { nodes: TopologyNode[]; links: TopologyLink[] }): void {
        this.peerConnections = []
        if (!this.node) { return }

        const peerMap = new Map<string, PeerLinkDetail[]>()

        for (const link of topo.links) {
            let peerId: string | null = null
            let localPortId = ''
            let remotePortId = ''

            if (link.sourceNodeId === this.nodeId) {
                peerId = link.targetNodeId
                localPortId = link.sourcePortId
                remotePortId = link.targetPortId
            } else if (link.targetNodeId === this.nodeId) {
                peerId = link.sourceNodeId
                localPortId = link.targetPortId
                remotePortId = link.sourcePortId
            }

            if (!peerId) { continue }

            const localPort = this.node!.ports.find(p => p.id === localPortId)
            const peerNode = topo.nodes.find(n => n.id === peerId)
            const remotePort = peerNode?.ports.find(p => p.id === remotePortId)

            const detail: PeerLinkDetail = {
                linkId: link.id,
                localPortId,
                localPortLabel: localPort?.label ?? '?',
                remotePortId,
                remotePortLabel: remotePort?.label ?? '?',
                linkStatus: link.status,
                vlanMode: localPort?.vlanMode as ('access' | 'trunk' | undefined),
            }

            if (!peerMap.has(peerId)) { peerMap.set(peerId, []) }
            peerMap.get(peerId)!.push(detail)
        }

        for (const [peerId, links] of peerMap) {
            const peerNode = topo.nodes.find(n => n.id === peerId)
            const peerRole = peerNode?.role ?? 'custom'
            const roleMeta = NODE_ROLE_META[peerRole]
            this.peerConnections.push({
                peerId,
                peerLabel: peerNode?.label ?? '?',
                peerRole: roleMeta?.label ?? peerRole,
                peerRoleColor: roleMeta?.color ?? '#6b7280',
                links,
            })
        }

        this.peerConnections.sort((a, b) => a.peerLabel.localeCompare(b.peerLabel))
    }

    // ── Tab navigation ──────────────────────────────────────────────────────

    setTab (tab: PanelTab): void {
        this.activeTab = tab
        // Auto-fetch bridge list when switching to ports tab on a bridge node
        if (tab === 'ports' && this.isBridgeNode && !this.bridgeListForNode.length) {
            this.fetchBridgeList()
        }
        this.cdr.markForCheck()
    }

    // ── Enhancement helpers ──────────────────────────────────────────────────

    toggleServiceSection (): void {
        this.showServiceSection = !this.showServiceSection
        this.cdr.markForCheck()
    }

    navigateToPeer (peerId: string): void {
        this.nodeSelected.emit(peerId)
    }

    scrollToPort (portId: string): void {
        this.activeTab = 'ports'
        this.cdr.markForCheck()
        setTimeout(() => {
            const el = document.getElementById('port-' + portId)
            el?.scrollIntoView({ behavior: 'smooth', block: 'center' })
        }, 50)
    }

    // ── Info tab ────────────────────────────────────────────────────────────

    applyLabel (): void {
        if (!this.nodeId || !this.draft.label?.trim()) { return }
        this.svc.updateNodeConfig(this.nodeId, { label: this.draft.label.trim() })
    }

    applyDescription (): void {
        if (!this.nodeId) { return }
        this.svc.updateNodeConfig(this.nodeId, { description: this.draft.description ?? '' })
    }

    applyRam (value: number): void {
        if (!this.nodeId) { return }
        this.draft.ram = value
        this.svc.updateNodeConfig(this.nodeId, { ram: value })
        this.cdr.markForCheck()
    }

    applyImage (): void {
        if (!this.nodeId) { return }
        this.svc.updateNodeConfig(this.nodeId, { image: this.draft.image ?? '' })
    }

    applyServerId (value: string): void {
        if (!this.nodeId) { return }
        this.draft.serverId = value || undefined
        this.svc.updateNodeConfig(this.nodeId, { serverId: value || undefined })
        // Refresh this.node so fetchHostInterfaces reads the new serverId
        this.node = this.svc.getNode(this.nodeId) ?? null
        // Re-fetch interfaces from the new server for host/bridge nodes
        // Remove all existing links and ports — old server's interfaces are invalid on the new server
        if (this.isHostNode) {
            this._clearHostPortsAndLinks()
            this.hostInterfaces = []
            this.fetchHostInterfaces(true)
        }
        if (this.isBridgeNode) {
            this.bridgeListForNode = []
            this.fetchBridgeList()
        }
    }

    applyVendor (): void {
        if (!this.nodeId) { return }
        const vendor = (this.draft.vendor ?? '').trim()
        this.svc.updateNodeConfig(this.nodeId, { vendor })
    }

    private _sanitizeSwitchFamily (value: unknown): SwitchFamily | '' {
        const raw = String(value ?? '').trim()
        if (!raw) { return '' }
        // Check against all known families (case-sensitive match)
        if (ALL_SWITCH_FAMILIES.has(raw)) { return raw as SwitchFamily }
        // Legacy: uppercase check for QFX/EX
        const upper = raw.toUpperCase()
        if (upper === 'QFX' || upper === 'EX') { return upper as SwitchFamily }
        return ''
    }

    private _sanitizeModel (value: unknown): string {
        return String(value ?? '').trim()
    }

    private _inferSwitchFamily (switchFamily?: SwitchFamily, model?: string): SwitchFamily | '' {
        if (switchFamily === 'QFX' || switchFamily === 'EX' || switchFamily === 'MX' || switchFamily === 'PTX' || switchFamily === 'PTX-EVO' || switchFamily === 'ACX') { return switchFamily }
        const normalizedModel = this._sanitizeModel(model).toUpperCase()
        if (normalizedModel.startsWith('QFX')) { return 'QFX' }
        if (normalizedModel.startsWith('EX')) { return 'EX' }
        if (normalizedModel.startsWith('MX')) { return 'MX' }
        if (normalizedModel.includes('EVO') && normalizedModel.includes('PTX')) { return 'PTX-EVO' }
        if (normalizedModel.startsWith('PTX')) { return 'PTX' }
        if (normalizedModel.startsWith('ACX')) { return 'ACX' }
        return ''
    }

    private _qfxProfileForModel (model: string): QfxModelProfile | null {
        const key = this._sanitizeModel(model).toLowerCase()
        return key ? (QFX_MODEL_PROFILE_BY_KEY.get(key) ?? null) : null
    }

    private _qfxPortLabels (model: string): string[] | null {
        const profile = this._qfxProfileForModel(model)
        if (!profile) { return null }
        const labels: string[] = []
        let index = 0
        for (const group of profile.portGroups) {
            for (let i = 0; i < group.count; i += 1) {
                labels.push(`${group.suffix}-0/0/${index}`)
                index += 1
            }
        }
        return labels
    }

    private _qfxLastGroupSuffix (model: string): string {
        const profile = this._qfxProfileForModel(model)
        if (!profile || !profile.portGroups.length) { return 'et' }
        return profile.portGroups[profile.portGroups.length - 1].suffix
    }

    private _qfxPortIndexFromLabel (label: string): number | null {
        const base = label.includes(':') ? label.split(':')[0].trim() : label.trim()
        const match = base.match(/-(\d+)\/(\d+)\/(\d+)$/)
        if (!match) { return null }
        const index = Number(match[3])
        return Number.isFinite(index) ? Math.trunc(index) : null
    }

    private _qfxGroupForPortLabel (model: string, label: string): JuniperPortGroup | null {
        const profile = this._qfxProfileForModel(model)
        const portIndex = this._qfxPortIndexFromLabel(label)
        if (!profile || portIndex === null || portIndex < 0) { return null }

        let cursor = 0
        for (const group of profile.portGroups) {
            const end = cursor + group.count
            if (portIndex >= cursor && portIndex < end) { return group }
            cursor = end
        }
        return null
    }

    private _allowedSpeedsForPort (port: NodePort): PortSpeed[] {
        const all = this.speedPresets
            .filter(s => !!s.value)
            .map(s => s.value as PortSpeed)
        const vendor = (this.draft.vendor ?? this.node?.vendor ?? '').trim().toLowerCase()
        const switchFamily = this._sanitizeSwitchFamily(this.draft.switchFamily ?? this.node?.switchFamily ?? '')
        const model = this._sanitizeModel(this.draft.model ?? this.node?.model ?? '')
        if (vendor !== 'juniper' || switchFamily !== 'QFX') { return all }

        const group = this._qfxGroupForPortLabel(model, port.label)
        return group?.speeds?.length ? group.speeds : all
    }

    private _isSpeedAllowedForPort (port: NodePort, speed?: PortSpeed): boolean {
        if (!speed) { return true }
        return this._allowedSpeedsForPort(port).includes(speed)
    }

    private _speedBreakoutChannelsForPort (port: NodePort): number | null {
        const vendor = (this.draft.vendor ?? this.node?.vendor ?? '').trim().toLowerCase()
        const switchFamily = this._sanitizeSwitchFamily(this.draft.switchFamily ?? this.node?.switchFamily ?? '')
        if (vendor !== 'juniper' || switchFamily !== 'QFX') { return null }

        const model = this._sanitizeModel(this.draft.model ?? this.node?.model ?? '').toUpperCase()
        if (!model) { return null }
        const speed = port.speed
        if (!speed) { return null }

        const isQfx524x = model.startsWith('QFX5240') || model.startsWith('QFX5241')
        if (isQfx524x) {
            if (speed === '800G') { return 1 }
            if (speed === '400G') { return 2 }
            if (speed === '200G') { return 4 }
            if (speed === '100G') { return 8 }
            return null
        }

        const isQfx523x513x522x =
            model.startsWith('QFX5230') ||
            model.startsWith('QFX5130') ||
            model.startsWith('QFX5220')
        if (isQfx523x513x522x) {
            if (speed === '400G') { return 1 }
            if (speed === '200G') { return 4 }
            if (speed === '100G') { return 8 }
            return null
        }

        return null
    }

    private _supportedSpeedsForCurrentPortSuffix (): PortSpeed[] {
        const suffix = this._sanitizePortSuffix(this.draft.portSuffix ?? this.node?.portSuffix ?? '').toLowerCase()
        if (!suffix) { return [] }

        const vendor = (this.draft.vendor ?? this.node?.vendor ?? '').trim().toLowerCase()
        const switchFamily = this._sanitizeSwitchFamily(this.draft.switchFamily ?? this.node?.switchFamily ?? '')
        const model = this._sanitizeModel(this.draft.model ?? this.node?.model ?? '')
        if (vendor !== 'juniper' || switchFamily !== 'QFX') { return [] }

        const profile = this._qfxProfileForModel(model)
        if (!profile) { return [] }

        const allowed = new Set<PortSpeed>()
        for (const group of profile.portGroups) {
            if (group.suffix !== suffix) { continue }
            for (const speed of group.speeds) { allowed.add(speed) }
        }
        if (!allowed.size) { return [] }

        return this.speedPresets
            .map(s => s.value)
            .filter((v): v is PortSpeed => !!v && allowed.has(v))
    }

    get portSuffixOperatingSpeedText (): string {
        return this._supportedSpeedsForCurrentPortSuffix().join('/')
    }

    get operatingSpeedOptionsForSuffix (): { label: string; value: PortSpeed | undefined }[] {
        const supported = this._supportedSpeedsForCurrentPortSuffix()
        if (!supported.length) { return this.speedPresets }
        const allowed = new Set(supported)
        return this.speedPresets.filter(s => !s.value || allowed.has(s.value))
    }

    portSpeedPresetsForPort (port: NodePort): { label: string; value: PortSpeed | undefined }[] {
        const allowed = new Set(this._allowedSpeedsForPort(port))
        return this.speedPresets.filter(s => !s.value || allowed.has(s.value))
    }

    onSwitchFamilyChange (switchFamilyRaw: string): void {
        if (!this.nodeId) { return }
        const switchFamily = this._sanitizeSwitchFamily(switchFamilyRaw)
        this.draft.switchFamily = switchFamily || undefined

        const changes: Partial<TopologyNode> = { switchFamily: switchFamily || undefined }
        const vendor = (this.draft.vendor ?? this.node?.vendor ?? '').trim().toLowerCase()
        const profileKey = `${vendor}:${switchFamily}`
        const profiles = VENDOR_MODEL_PROFILES_MAP[profileKey]

        if (profiles?.length) {
            // Auto-select first model if current doesn't match any profile
            const currentModel = this._sanitizeModel(this.draft.model)
            const hasMatch = profiles.some(p => p.model.toLowerCase() === currentModel.toLowerCase())
            if (!hasMatch) {
                const first = profiles[0].model
                this.draft.model = first
                changes.model = first
            } else {
                changes.model = currentModel
            }
            // Set default port suffix from selected/first profile
            const selectedModel = (changes.model ?? currentModel).toLowerCase()
            const profile = profiles.find(p => p.model.toLowerCase() === selectedModel) ?? profiles[0]
            if (!this._sanitizePortSuffix(this.draft.portSuffix ?? '')) {
                const defaultSuffix = profile.portGroups[profile.portGroups.length - 1]?.suffix ?? ''
                if (defaultSuffix) {
                    this.draft.portSuffix = defaultSuffix
                    changes.portSuffix = defaultSuffix
                }
            }
        } else if (switchFamily) {
            // Family with no profiles (e.g. Juniper EX) — set sensible default suffix
            if (!this._sanitizePortSuffix(this.draft.portSuffix ?? '')) {
                const defaultSuffix = this._defaultSuffixForVendor(vendor)
                if (defaultSuffix) {
                    this.draft.portSuffix = defaultSuffix
                    changes.portSuffix = defaultSuffix
                }
            }
        }
        this.svc.updateNodeConfig(this.nodeId, changes)
        this.generateVendorPorts()
    }

    /** Return a sensible default port suffix for a vendor (when no model profile is selected) */
    private _defaultSuffixForVendor (vendorKey: string): string {
        switch (vendorKey) {
            case 'juniper': return 'ge'
            case 'cisco':   return 'Gi'
            case 'arista':  return 'Ethernet'
            case 'sonic':   return 'Ethernet'
            case 'nokia':   return 'ethernet'
            case 'hpe':     return ''
            case 'huawei':  return 'GigabitEthernet'
            case 'dell':    return 'ethernet'
            case 'mikrotik': return 'ether'
            case 'extreme': return '1:'
            default:        return ''
        }
    }

    applyModel (): void {
        if (!this.nodeId) { return }
        const model = this._sanitizeModel(this.draft.model)
        this.draft.model = model
        this.svc.updateNodeConfig(this.nodeId, { model })
    }

    onModelChange (modelRaw: string): void {
        if (!this.nodeId) { return }
        const model = this._sanitizeModel(modelRaw)
        this.draft.model = model

        const changes: Partial<TopologyNode> = { model }
        const vendor = (this.draft.vendor ?? this.node?.vendor ?? '').trim().toLowerCase()
        const switchFamily = this._sanitizeSwitchFamily(this.draft.switchFamily)

        // Try to infer family from model name if not already set
        if (!switchFamily) {
            const inferred = this._inferSwitchFamily(undefined, model)
            if (inferred) {
                this.draft.switchFamily = inferred
                changes.switchFamily = inferred
            }
        }

        // Set default port suffix from model profile if available
        const effectiveFamily = this._sanitizeSwitchFamily(this.draft.switchFamily)
        const profileKey = `${vendor}:${effectiveFamily}`
        const profiles = VENDOR_MODEL_PROFILES_MAP[profileKey]
        const profile = profiles?.find(p => p.model.toLowerCase() === model.toLowerCase())
        if (profile && !this._sanitizePortSuffix(this.draft.portSuffix ?? '')) {
            const defaultSuffix = profile.portGroups[profile.portGroups.length - 1]?.suffix ?? ''
            if (defaultSuffix) {
                this.draft.portSuffix = defaultSuffix
                changes.portSuffix = defaultSuffix
            }
        }

        this.svc.updateNodeConfig(this.nodeId, changes)
        this.generateVendorPorts()
    }

    private _sanitizeDesiredPortCount (value: unknown, fallback: number): number {
        const parsed = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(parsed)) { return fallback }
        const desired = Math.trunc(parsed)
        return Math.max(1, Math.min(256, desired))
    }

    applyDesiredPortCount (): void {
        if (!this.nodeId || !this.node) { return }
        const fallback = Math.max(1, this.node.ports.length || 1)
        const desiredPortCount = this._sanitizeDesiredPortCount(
            this.draft.desiredPortCount ?? this.node.desiredPortCount ?? fallback,
            fallback,
        )
        this.draft.desiredPortCount = desiredPortCount
        this.svc.updateNodeConfig(this.nodeId, { desiredPortCount })
        this.generateVendorPorts()
    }

    private _sanitizePortSuffix (value: unknown): string {
        return String(value ?? '').trim().replace(/\s+/g, '')
    }

    private _sanitizeOperatingSpeed (value: unknown): PortSpeed | undefined {
        const raw = String(value ?? '').trim()
        if (!raw) { return undefined }
        const valid = this.speedPresets.some(s => s.value === raw)
        return valid ? raw as PortSpeed : undefined
    }

    applyPortSuffix (): void {
        if (!this.nodeId) { return }
        const portSuffix = this._sanitizePortSuffix(this.draft.portSuffix ?? '')
        this.draft.portSuffix = portSuffix
        this.svc.updateNodeConfig(this.nodeId, { portSuffix })
        const vendor = (this.draft.vendor ?? this.node?.vendor ?? '').trim()
        if (vendor) {
            this.generateVendorPorts()
            return
        }
        if (this.draft.operatingSpeed !== undefined) {
            this.applyOperatingSpeed(this.draft.operatingSpeed)
            return
        }
        this.cdr.markForCheck()
    }

    private _portTypePrefix (label: string): string {
        const base = this._portBaseLabel(label)
        const match = base.match(/^([A-Za-z]+)/)
        return (match?.[1] ?? '').toLowerCase()
    }

    private _portMatchesSuffix (port: NodePort, suffix: string): boolean {
        const normalized = this._sanitizePortSuffix(suffix).toLowerCase()
        if (!normalized) { return true }
        return this._portTypePrefix(port.label) === normalized
    }

    private _applyOperatingSpeedToPorts (
        ports: NodePort[],
        suffix: string,
        operatingSpeed?: PortSpeed,
    ): { ports: NodePort[]; updated: number; skipped: number; skipReason: string } {
        let updated = 0
        let skipped = 0
        const skippedGroups = new Map<string, number>()
        const next = ports.map(port => {
            if (!this._portMatchesSuffix(port, suffix)) { return port }
            if (operatingSpeed && !this._isSpeedAllowedForPort(port, operatingSpeed)) {
                skipped += 1
                const allowed = this._allowedSpeedsForPort(port)
                const groupKey = allowed.join('/')
                skippedGroups.set(groupKey, (skippedGroups.get(groupKey) ?? 0) + 1)
                return port
            }
            if ((port.speed ?? undefined) === operatingSpeed) { return port }
            updated += 1
            return { ...port, speed: operatingSpeed }
        })
        const skipParts: string[] = []
        for (const [speeds, count] of skippedGroups) {
            skipParts.push(`${count} skipped (${speeds}-only)`)
        }
        return { ports: next, updated, skipped, skipReason: skipParts.join(', ') }
    }

    private _groupPortIdsForBase (ports: NodePort[], baseLabel: string): Set<string> {
        return new Set(
            ports
                .filter(p => p.label === baseLabel || p.label.startsWith(`${baseLabel}:`))
                .map(p => p.id),
        )
    }

    private _enforceBreakoutPolicyForSuffix (
        ports: NodePort[],
        suffix: string,
    ): { ports: NodePort[]; adjusted: number; linkedLocked: number } {
        if (!this.nodeId) { return { ports, adjusted: 0, linkedLocked: 0 } }

        const linkedIds = new Set<string>()
        for (const link of this.svc.topology.links) {
            if (link.sourceNodeId === this.nodeId) { linkedIds.add(link.sourcePortId) }
            if (link.targetNodeId === this.nodeId) { linkedIds.add(link.targetPortId) }
        }

        const baseLabels = new Set<string>()
        for (const port of ports) {
            if (!this._portMatchesSuffix(port, suffix)) { continue }
            baseLabels.add(this._portBaseLabel(port.label))
        }
        if (!baseLabels.size) { return { ports, adjusted: 0, linkedLocked: 0 } }

        const usedIds = new Set(ports.map(p => p.id))
        const rebuiltByBase = new Map<string, NodePort[]>()
        let adjusted = 0
        let linkedLocked = 0

        for (const baseLabel of baseLabels) {
            const group = ports.filter(p => p.label === baseLabel || p.label.startsWith(`${baseLabel}:`))
            if (!group.length) { continue }

            const representative = group.find(p => this._channelIndexFromLabel(p.label) === 0)
                ?? group.find(p => p.label === baseLabel)
                ?? group[0]
            const desired = this._speedBreakoutChannelsForPort(representative)
            if (desired === null) { continue }

            const existingByChannel = new Map<number, NodePort>()
            for (const p of group) {
                const ch = this._channelIndexFromLabel(p.label)
                existingByChannel.set(ch ?? 0, p)
            }

            if (desired === 1) {
                const linkedChildCount = group.filter(p => {
                    const ch = this._channelIndexFromLabel(p.label)
                    return ch !== null && ch > 0 && linkedIds.has(p.id)
                }).length
                if (linkedChildCount > 0) {
                    linkedLocked += 1
                    continue
                }

                const primary = existingByChannel.get(0) ?? representative
                rebuiltByBase.set(baseLabel, [{
                    id: primary.id,
                    label: baseLabel,
                    enabled: primary.enabled,
                    ipAddress: primary.ipAddress,
                    description: primary.description,
                    speed: primary.speed,
                    vlan: primary.vlan,
                    vlanMode: primary.vlanMode,
                    trunkNativeVlan: primary.trunkNativeVlan,
                    trunkAllowedVlans: primary.trunkAllowedVlans,
                }])
                adjusted += 1
                continue
            }

            let minChannelsRequired = 1
            for (const [ch, p] of existingByChannel) {
                if (linkedIds.has(p.id)) {
                    minChannelsRequired = Math.max(minChannelsRequired, ch + 1)
                }
            }
            const target = Math.max(desired, minChannelsRequired)
            if (target > desired) { linkedLocked += 1 }

            for (const id of this._groupPortIdsForBase(ports, baseLabel)) { usedIds.delete(id) }

            const seed = existingByChannel.get(0) ?? representative
            const rebuilt: NodePort[] = []
            for (let ch = 0; ch < target; ch += 1) {
                const existing = existingByChannel.get(ch)
                const id = existing?.id
                    ?? (ch === 0 ? seed.id : this._nextPortId(usedIds, `${seed.id}_ch${ch}`))

                rebuilt.push({
                    id,
                    label: `${baseLabel}:${ch}`,
                    enabled: existing?.enabled ?? seed.enabled,
                    ipAddress: existing?.ipAddress ?? '',
                    description: existing?.description ?? '',
                    speed: existing?.speed ?? seed.speed,
                    vlan: existing?.vlan ?? seed.vlan,
                    vlanMode: existing?.vlanMode ?? seed.vlanMode,
                    trunkNativeVlan: existing?.trunkNativeVlan ?? seed.trunkNativeVlan,
                    trunkAllowedVlans: existing?.trunkAllowedVlans ?? seed.trunkAllowedVlans,
                })
            }
            rebuiltByBase.set(baseLabel, rebuilt)
            adjusted += 1
        }

        if (!rebuiltByBase.size) { return { ports, adjusted: 0, linkedLocked } }

        const groupIdToBase = new Map<string, string>()
        for (const base of rebuiltByBase.keys()) {
            for (const id of this._groupPortIdsForBase(ports, base)) {
                groupIdToBase.set(id, base)
            }
        }

        const next: NodePort[] = []
        const inserted = new Set<string>()
        for (const port of ports) {
            const base = groupIdToBase.get(port.id)
            if (!base) {
                next.push(port)
                continue
            }
            if (inserted.has(base)) { continue }
            inserted.add(base)
            next.push(...(rebuiltByBase.get(base) ?? [port]))
        }

        return { ports: next, adjusted, linkedLocked }
    }

    applyOperatingSpeed (value: unknown): void {
        if (!this.nodeId || !this.node) { return }
        const operatingSpeed = this._sanitizeOperatingSpeed(value ?? this.draft.operatingSpeed)
        this.draft.operatingSpeed = operatingSpeed

        const suffix = this._sanitizePortSuffix(this.draft.portSuffix ?? this.node.portSuffix ?? '').toLowerCase()
        const applied = this._applyOperatingSpeedToPorts(this.node.ports, suffix, operatingSpeed)
        const breakout = this._enforceBreakoutPolicyForSuffix(applied.ports, suffix)
        const update: Partial<TopologyNode> = {
            operatingSpeed,
            ports: breakout.ports,
        }
        const vendor = (this.draft.vendor ?? this.node.vendor ?? '').trim()
        if (vendor) {
            const startupConfig = this._buildVendorStartupConfig(vendor, breakout.ports)
            this.draft.startupConfig = startupConfig
            update.startupConfig = startupConfig
        }
        this.svc.updateNodeConfig(this.nodeId, update)

        const speedLabel = operatingSpeed ?? 'Auto'
        const detailParts: string[] = []
        if (applied.skipReason) { detailParts.push(applied.skipReason) }
        else if (applied.skipped) { detailParts.push(`${applied.skipped} speed skipped`) }
        if (breakout.adjusted) { detailParts.push(`${breakout.adjusted} breakout adjusted`) }
        if (breakout.linkedLocked) { detailParts.push(`${breakout.linkedLocked} breakout linked-locked`) }
        const detail = detailParts.length ? ` (${detailParts.join(', ')})` : ''
        this.portGenMsg = `Applied operating speed ${speedLabel} to ${applied.updated} interface(s)${detail}`
        this.cdr.markForCheck()
    }

    onVendorChange (vendor: string): void {
        this.draft.vendor = vendor
        this.applyVendor()
        const vendorKey = vendor.trim().toLowerCase()
        const families = VENDOR_DEVICE_FAMILIES[vendorKey]
        if (families?.length) {
            const currentFamily = this._sanitizeSwitchFamily(this.draft.switchFamily)
            const familyValid = currentFamily && families.includes(currentFamily as SwitchFamily)
            if (!familyValid) {
                // Default to first family for the vendor
                const defaultFamily = families[0]
                this.draft.switchFamily = defaultFamily
                this.svc.updateNodeConfig(this.nodeId!, { switchFamily: defaultFamily })
            }
        } else {
            // Vendor has no families — clear switchFamily
            this.draft.switchFamily = undefined
            this.svc.updateNodeConfig(this.nodeId!, { switchFamily: undefined })
        }
        // Confirm before overwriting existing port labels
        if (this.node && this.node.ports.length > 0) {
            const ok = confirm(
                `Switching to ${vendor} will relabel all ${this.node.ports.length} ports and regenerate startup config.\n\n` +
                `Existing IP addresses and link connections will be preserved.\n\nProceed?`
            )
            if (!ok) { return }
        }
        this.generateVendorPorts()
    }

    /** SONiC interface index step — configurable; default 4 matches SONiC breakout naming */
    private _sonicPortStep = 4

    private _vendorLabelForIndex (
        type: 'router' | 'switch',
        vendor: string,
        index: number,
        portSuffix = '',
    ): string {
        const v = vendor.trim().toLowerCase()
        const suffix = this._sanitizePortSuffix(portSuffix)

        if (suffix) {
            if (v === 'juniper') {
                return `${suffix}-0/0/${index}`
            }
            if (v === 'cisco') {
                return type === 'switch'
                    ? `${suffix}1/0/${index + 1}`
                    : `${suffix}0/${index}`
            }
            if (v === 'huawei') {
                return type === 'switch'
                    ? `${suffix}1/0/${index + 1}`
                    : `${suffix}0/0/${index}`
            }
            if (v === 'sonic') { return `${suffix}${index * this._sonicPortStep}` }
            if (v === 'nokia') { return `${suffix}-1/1/${index + 1}` }
            if (v === 'arista') { return `${suffix}${index + 1}` }
            if (v === 'dell') { return `${suffix}1/1/${index + 1}` }
            if (v === 'mikrotik') { return `${suffix}${index + 1}` }
            if (v === 'extreme') { return `${suffix}${index + 1}` }
            if (v === 'hpe') {
                return type === 'switch'
                    ? `${suffix}${index + 1}`
                    : `${suffix}1/1/${index + 1}`
            }
            return `${suffix}${index + 1}`
        }

        if (v === 'cisco') {
            return type === 'switch'
                ? `Gi1/0/${index + 1}`
                : `Gi0/${index}`
        }
        if (v === 'juniper') { return `ge-0/0/${index}` }
        if (v === 'arista') { return `Ethernet${index + 1}` }
        if (v === 'sonic') { return `Ethernet${index * this._sonicPortStep}` }
        if (v === 'nokia') {
            return type === 'switch'
                ? `1/1/${index + 1}`
                : `ethernet-1/1/${index + 1}`
        }
        if (v === 'hpe') {
            return type === 'switch'
                ? `${index + 1}`
                : `1/1/${index + 1}`
        }
        if (v === 'huawei') {
            return type === 'switch'
                ? `GigabitEthernet1/0/${index + 1}`
                : `GigabitEthernet0/0/${index}`
        }
        if (v === 'dell') { return `ethernet1/1/${index + 1}` }
        if (v === 'mikrotik') { return `ether${index + 1}` }
        if (v === 'extreme') { return `1:${index + 1}` }

        return type === 'switch' ? `port-${index + 1}` : `eth${index + 1}`
    }

    /** Generate port labels from a generic vendor model profile */
    private _vendorModelPortLabels (vendorKey: string, nodeType: string, profile: VendorModelProfile): string[] {
        const labels: string[] = []
        if (CONTINUOUS_INDEX_VENDORS.has(vendorKey)) {
            // Continuous index across all port groups
            let globalIndex = 0
            for (const group of profile.portGroups) {
                for (let i = 0; i < group.count; i += 1) {
                    labels.push(this._vendorLabelForIndex(nodeType as 'router' | 'switch', vendorKey, globalIndex, group.suffix))
                    globalIndex += 1
                }
            }
        } else {
            // Per-group index (Cisco, Huawei, MikroTik)
            for (const group of profile.portGroups) {
                for (let i = 0; i < group.count; i += 1) {
                    labels.push(this._vendorLabelForIndex(nodeType as 'router' | 'switch', vendorKey, i, group.suffix))
                }
            }
        }
        return labels
    }

    private _buildVendorStartupConfig (vendor: string, ports: NodePort[]): string {
        if (!this.node || !this.nodeId) { return '' }

        const topo = this.svc.topology
        const nodeMap = new Map(topo.nodes.map(n => [n.id, n]))
        const loopIp = (this.draft.loopbackIp ?? this.node.loopbackIp ?? this.draft.mgmtIp ?? this.node.mgmtIp ?? '').split('/')[0].trim()
        const asn = this.draft.asn ?? this.node.asn
        const ospfArea = this.draft.ospfArea ?? this.node.ospfArea
        const isisLevel = this.draft.isisLevel ?? this.node.isisLevel

        // Compute BGP neighbors from links
        const bgpNeighbors: { ip: string; peerAsn: number; portLabel: string; peerHostname: string }[] = []
        if (asn != null) {
            const isIbgpRr = topo.underlayProtocol === 'ibgp-rr'
            for (const link of topo.links) {
                let peerNode: typeof this.node | undefined
                let localPort: NodePort | undefined
                if (link.sourceNodeId === this.nodeId) {
                    peerNode = nodeMap.get(link.targetNodeId)
                    localPort = ports.find(p => p.id === link.sourcePortId) ?? this.node.ports.find(p => p.id === link.sourcePortId)
                } else if (link.targetNodeId === this.nodeId) {
                    peerNode = nodeMap.get(link.sourceNodeId)
                    localPort = ports.find(p => p.id === link.targetPortId) ?? this.node.ports.find(p => p.id === link.targetPortId)
                }
                if (!peerNode || peerNode.asn == null || !localPort) { continue }

                const peerPort = link.sourceNodeId === this.nodeId
                    ? peerNode.ports.find(p => p.id === link.targetPortId)
                    : peerNode.ports.find(p => p.id === link.sourcePortId)
                if (!peerPort?.ipAddress) { continue }

                const sameAsn = asn === peerNode.asn
                const useLoopback = isIbgpRr && sameAsn
                const peerLoopback = (peerNode.loopbackIp ?? peerNode.mgmtIp)?.split('/')[0]
                const peerIp = useLoopback && peerLoopback ? peerLoopback : peerPort.ipAddress.split('/')[0]

                if (!bgpNeighbors.some(nb => nb.ip === peerIp)) {
                    bgpNeighbors.push({ ip: peerIp, peerAsn: peerNode.asn, portLabel: localPort.label, peerHostname: peerNode.label })
                }
            }
        }

        // Compute OSPF interfaces from links
        const ospfInterfaces: { portLabel: string; area: number }[] = []
        if (ospfArea != null) {
            for (const link of topo.links) {
                let localPortId: string | undefined
                let peerNode: typeof this.node | undefined
                if (link.sourceNodeId === this.nodeId) {
                    localPortId = link.sourcePortId; peerNode = nodeMap.get(link.targetNodeId)
                } else if (link.targetNodeId === this.nodeId) {
                    localPortId = link.targetPortId; peerNode = nodeMap.get(link.sourceNodeId)
                }
                if (!localPortId || !peerNode) { continue }
                if (ospfArea == null && peerNode.ospfArea == null) { continue }
                const localPort = ports.find(p => p.id === localPortId) ?? this.node.ports.find(p => p.id === localPortId)
                const peerPort = link.sourceNodeId === this.nodeId
                    ? peerNode.ports.find(p => p.id === link.targetPortId)
                    : peerNode.ports.find(p => p.id === link.sourcePortId)
                if (!localPort?.ipAddress || !peerPort?.ipAddress) { continue }
                const linkArea = ospfArea === (peerNode.ospfArea ?? 0) ? ospfArea : Math.max(ospfArea, peerNode.ospfArea ?? 0)
                ospfInterfaces.push({ portLabel: localPort.label, area: linkArea })
            }
        }

        // Compute IS-IS interfaces from links
        const isisInterfaces: { portLabel: string; level: 1 | 2 | 12 }[] = []
        if (isisLevel != null) {
            for (const link of topo.links) {
                let localPortId: string | undefined
                let peerNode: typeof this.node | undefined
                if (link.sourceNodeId === this.nodeId) {
                    localPortId = link.sourcePortId; peerNode = nodeMap.get(link.targetNodeId)
                } else if (link.targetNodeId === this.nodeId) {
                    localPortId = link.targetPortId; peerNode = nodeMap.get(link.sourceNodeId)
                }
                if (!localPortId || !peerNode) { continue }
                if (isisLevel == null && peerNode.isisLevel == null) { continue }
                const localPort = ports.find(p => p.id === localPortId) ?? this.node.ports.find(p => p.id === localPortId)
                const peerPort = link.sourceNodeId === this.nodeId
                    ? peerNode.ports.find(p => p.id === link.targetPortId)
                    : peerNode.ports.find(p => p.id === link.sourcePortId)
                if (!localPort?.ipAddress || !peerPort?.ipAddress) { continue }
                isisInterfaces.push({ portLabel: localPort.label, level: isisLevel as 1 | 2 | 12 })
            }
        }

        // Compute IS-IS NET address from loopback IP
        let isisNet: string | undefined
        if (isisLevel != null && loopIp) {
            const parts = loopIp.split('.').map(Number)
            if (parts.length === 4 && !parts.some(p => !Number.isFinite(p))) {
                const padded = parts.map(p => String(p).padStart(3, '0')).join('')
                isisNet = `49.0001.${padded.slice(0, 4)}.${padded.slice(4, 8)}.${padded.slice(8, 12)}.00`
            }
        }

        // Determine underlay protocol
        const topoUnderlay = topo.underlayProtocol
        const underlay = topoUnderlay ?? (asn != null ? 'ebgp' : (ospfArea != null ? 'ospf' : (isisLevel != null ? 'isis' : undefined)))

        // Overlay neighbors (loopback IPs by role)
        const topoOverlay = topo.overlayEnabled === true
        const spineLoopbacks: string[] = []
        const leafLoopbacks: string[] = []
        if (topoOverlay) {
            for (const n of topo.nodes) {
                const nLoopIp = (n.loopbackIp ?? n.mgmtIp)?.split('/')[0]
                if (!nLoopIp || n.asn == null) { continue }
                if (n.role === 'spine' || n.role === 'super-spine') { spineLoopbacks.push(nLoopIp) }
                else if (n.role === 'leaf' || n.role === 'border-leaf' || n.role === 'tor') { leafLoopbacks.push(nLoopIp) }
            }
        }

        const vniBase = topo.vniBase ?? 10000
        const nodeRole = this.node.role
        const isSpine = nodeRole === 'spine' || nodeRole === 'super-spine'

        const ctx: VendorConfigContext = {
            nodeType: this.node.type,
            hostname: (this.draft.label ?? this.node.label ?? '').trim() || this.node.label,
            mgmtIp: (this.draft.mgmtIp ?? this.node.mgmtIp ?? '').trim(),
            loopbackIp: (this.draft.loopbackIp ?? this.node.loopbackIp ?? '').trim(),
            loopbackIpv6: (this.draft.loopbackIpv6 ?? this.node.loopbackIpv6 ?? '').trim(),
            sshUsername: (this.draft.sshUsername ?? this.node.sshUsername ?? '').trim(),
            model: this._sanitizeModel(this.draft.model ?? this.node.model ?? ''),
            switchFamily: this._sanitizeSwitchFamily(this.draft.switchFamily ?? this.node.switchFamily ?? ''),
            vlans: this.node.vlans ?? [],

            // BGP underlay
            asn,
            routerId: loopIp || undefined,
            bgpNeighbors,
            underlayProtocol: underlay,
            isRouteReflector: topo.underlayProtocol === 'ibgp-rr' && isSpine,

            // EVPN-VXLAN overlay
            overlayEnabled: topoOverlay && asn != null && (this.node.vlans?.length ?? 0) > 0,
            overlayNeighbors: (nodeRole === 'leaf' || nodeRole === 'border-leaf' || nodeRole === 'tor') ? spineLoopbacks : leafLoopbacks,
            vniMappings: isSpine ? [] : (this.node.vlans ?? [])
                .filter(v => v.id >= 100 && v.id < 4000)
                .map(v => ({ vlanId: v.id, vni: vniBase + v.id, vlanName: v.name })),
            vtepSourceIp: isSpine ? undefined : (loopIp || undefined),
            nodeRole,

            // OSPF
            ospfInterfaces,
            ospfArea,

            // IS-IS
            isisInterfaces,
            isisLevel: isisLevel as 1 | 2 | 12 | undefined,
            isisNet,

            // SR-MPLS / SRv6 / MPLS-LDP
            nodeSid: this.draft.nodeSid ?? this.node.nodeSid,
            srv6Locator: (this.draft.srv6Locator ?? this.node.srv6Locator ?? '').trim() || undefined,
            mplsLdp: this.draft.mplsLdp ?? this.node.mplsLdp,
            mplsInterfaces: isisInterfaces.map(i => i.portLabel),
        }
        return buildVendorStartupConfig(vendor, ports, ctx)
    }

    generateVendorPorts (): void {
        if (!this.nodeId || !this.node) { return }
        if (this.node.type !== 'router' && this.node.type !== 'switch') { return }

        const vendor = (this.draft.vendor ?? this.node.vendor ?? '').trim()
        const vendorKey = vendor.toLowerCase()
        if (!vendor) {
            this.portGenMsg = 'Select vendor first'
            this.cdr.markForCheck()
            return
        }

        const switchFamily = this._sanitizeSwitchFamily(this.draft.switchFamily ?? this.node.switchFamily ?? '')
        this.draft.switchFamily = switchFamily || undefined
        const model = this._sanitizeModel(this.draft.model ?? this.node.model ?? '')
        this.draft.model = model

        let portSuffix = this._sanitizePortSuffix(this.draft.portSuffix ?? this.node.portSuffix ?? '')
        let fixedLabels: string[] | null = null

        // Juniper QFX — specialized path with per-group speed restrictions
        if (vendorKey === 'juniper' && this.node.type === 'switch' && switchFamily === 'QFX') {
            fixedLabels = this._qfxPortLabels(model)
            if (!fixedLabels) {
                this.portGenMsg = 'Select a valid QFX model to generate Juniper switch ports'
                this.cdr.markForCheck()
                return
            }
            if (!portSuffix) { portSuffix = 'et' }
        }

        // Generic vendor model profiles — generate fixed labels from profile port groups
        if (!fixedLabels && switchFamily && model) {
            const profileKey = `${vendorKey}:${switchFamily}`
            const profiles = VENDOR_MODEL_PROFILES_MAP[profileKey]
            const profile = profiles?.find(p => p.model.toLowerCase() === model.toLowerCase())
            if (profile) {
                fixedLabels = this._vendorModelPortLabels(vendorKey, this.node.type, profile)
                if (!portSuffix) {
                    portSuffix = profile.portGroups[profile.portGroups.length - 1]?.suffix ?? ''
                }
            }
        }
        this.draft.portSuffix = portSuffix

        const fixedDefault = fixedLabels?.length ?? 0
        const fallback = fixedDefault || Math.max(1, this.node.ports.length || 1)
        const count = this._sanitizeDesiredPortCount(
            this.draft.desiredPortCount ?? this.node.desiredPortCount ?? fallback,
            fallback,
        )
        this.draft.desiredPortCount = count

        // For model-based profiles: use fixed labels, then extend with vendor format
        const lastGroupSuffix = fixedLabels
            ? (vendorKey === 'juniper' ? this._qfxLastGroupSuffix(model) : (portSuffix || ''))
            : ''
        const labelForIndex = (idx: number): string => {
            if (fixedLabels && idx < fixedLabels.length) { return fixedLabels[idx] }
            if (fixedLabels && lastGroupSuffix && vendorKey === 'juniper') {
                return `${lastGroupSuffix}-0/0/${idx}`
            }
            return this._vendorLabelForIndex(
                this.node!.type as 'router' | 'switch',
                vendor,
                idx,
                portSuffix,
            )
        }

        // Collapse channelized sub-ports back to base ports before relabeling.
        // Sub-ports like et-0/0/0:0 .. :7 all share base et-0/0/0; keep only the
        // first occurrence so flat-index relabeling counts base ports, not sub-ports.
        // _enforceBreakoutPolicyForSuffix will re-expand them afterward.
        const seenBases = new Set<string>()
        const collapsed: NodePort[] = []
        for (const p of this.node.ports) {
            const colonIdx = p.label.indexOf(':')
            const base = colonIdx > 0 ? p.label.slice(0, colonIdx) : p.label
            if (seenBases.has(base)) { continue }
            seenBases.add(base)
            // Strip channel suffix from the label (will be relabeled below anyway)
            collapsed.push({ ...p, label: base })
        }

        const relabeled: NodePort[] = collapsed.map((p, idx) => ({
            ...p,
            label: labelForIndex(idx),
        }))

        const linkedPortIds = new Set<string>()
        for (const link of this.svc.topology.links) {
            if (link.sourceNodeId === this.nodeId) { linkedPortIds.add(link.sourcePortId) }
            if (link.targetNodeId === this.nodeId) { linkedPortIds.add(link.targetPortId) }
        }

        const pruned = [...relabeled]
        let removedPorts = 0
        while (pruned.length > count) {
            const removableIdx = [...pruned.keys()]
                .reverse()
                .find(idx => !linkedPortIds.has(pruned[idx].id))
            if (removableIdx === undefined) { break }
            pruned.splice(removableIdx, 1)
            removedPorts += 1
        }
        const keptLinkedBeyondCount = Math.max(0, pruned.length - count)

        const usedIds = new Set(pruned.map(p => p.id))
        const added: NodePort[] = []
        for (let idx = pruned.length; idx < count; idx++) {
            const idBase = `v${idx}`
            let id = idBase
            let suffix = 1
            while (usedIds.has(id)) {
                id = `${idBase}_${suffix}`
                suffix += 1
            }
            usedIds.add(id)
            added.push({
                id,
                label: labelForIndex(idx),
                enabled: true,
            })
        }

        const rawPorts = [...pruned, ...added]
        let speedResetCount = 0
        let ports = rawPorts.map(p => {
            if (this._isSpeedAllowedForPort(p, p.speed)) { return p }
            speedResetCount += 1
            return { ...p, speed: undefined }
        })

        const operatingSpeed = this._sanitizeOperatingSpeed(this.draft.operatingSpeed ?? this.node.operatingSpeed)
        this.draft.operatingSpeed = operatingSpeed
        let speedAppliedCount = 0
        let speedSkipReason = ''
        let breakoutAdjustedCount = 0
        let breakoutLinkedLockedCount = 0
        if (operatingSpeed) {
            const applied = this._applyOperatingSpeedToPorts(ports, portSuffix, operatingSpeed)
            ports = applied.ports
            speedAppliedCount = applied.updated
            speedSkipReason = applied.skipReason
        }
        const breakout = this._enforceBreakoutPolicyForSuffix(ports, portSuffix)
        ports = breakout.ports
        breakoutAdjustedCount = breakout.adjusted
        breakoutLinkedLockedCount = breakout.linkedLocked

        const startupConfig = this._buildVendorStartupConfig(vendor, ports)
        this.draft.startupConfig = startupConfig
        this.draft.desiredPortCount = count
        this.svc.updateNodeConfig(this.nodeId, {
            vendor,
            switchFamily: switchFamily || undefined,
            model,
            desiredPortCount: count,
            portSuffix,
            operatingSpeed,
            ports,
            startupConfig,
        })

        const details: string[] = []
        if (added.length) { details.push(`+${added.length} added`) }
        if (removedPorts) { details.push(`-${removedPorts} removed`) }
        if (keptLinkedBeyondCount) { details.push(`${keptLinkedBeyondCount} linked kept`) }
        if (speedResetCount) { details.push(`${speedResetCount} speed reset`) }
        if (speedAppliedCount) { details.push(`${speedAppliedCount} speed set`) }
        if (speedSkipReason) { details.push(speedSkipReason) }
        if (breakoutAdjustedCount) { details.push(`${breakoutAdjustedCount} breakout adjusted`) }
        if (breakoutLinkedLockedCount) { details.push(`${breakoutLinkedLockedCount} breakout linked-locked`) }
        if (switchFamily) { details.push(`type=${switchFamily}`) }
        if (model) { details.push(`model=${model}`) }
        if (portSuffix) { details.push(`suffix=${portSuffix}`) }
        this.portGenMsg = `Generated ${ports.length} ${vendor} port labels + startup config${details.length ? ` (${details.join(', ')})` : ''}`
        this.cdr.markForCheck()
    }

    applyAsn (): void {
        if (!this.nodeId) { return }
        const raw = this.draft.asn
        const asn = (raw != null && Number.isFinite(raw) && raw > 0 && raw <= 4294967295)
            ? Math.trunc(raw)
            : undefined
        this.svc.updateNodeConfig(this.nodeId, { asn })
        // ASN change affects BGP config for this node AND its neighbors → full regen
        this.svc.regenerateConfigs()
    }

    /** Returns asdot notation hint for 4-byte ASNs, e.g. "(asdot: 1.5)" */
    get asnAsdotHint (): string {
        const asn = this.draft.asn
        if (asn == null || !is4ByteAsn(asn)) { return '' }
        return `asdot: ${asnToAsdot(asn)}`
    }

    applyOspfArea (): void {
        if (!this.nodeId) { return }
        const raw = this.draft.ospfArea
        const ospfArea = (raw != null && Number.isFinite(raw) && raw >= 0)
            ? Math.trunc(raw)
            : undefined
        this.svc.updateNodeConfig(this.nodeId, { ospfArea })
        this.svc.regenerateConfigs()
    }

    applyIsisLevel (): void {
        if (!this.nodeId) { return }
        const raw = this.draft.isisLevel
        const isisLevel = (raw === 1 || raw === 2 || raw === 12) ? raw : undefined
        this.svc.updateNodeConfig(this.nodeId, { isisLevel })
        this.svc.regenerateConfigs()
    }

    applyNodeSid (): void {
        if (!this.nodeId) { return }
        const raw = this.draft.nodeSid
        const nodeSid = (raw != null && Number.isFinite(raw) && raw >= 0) ? Math.trunc(raw) : undefined
        this.svc.updateNodeConfig(this.nodeId, { nodeSid })
        this.svc.regenerateConfigs()
    }

    applySrv6Locator (): void {
        if (!this.nodeId) { return }
        const srv6Locator = (this.draft.srv6Locator ?? '').trim() || undefined
        this.svc.updateNodeConfig(this.nodeId, { srv6Locator })
        this.svc.regenerateConfigs()
    }

    applySrgbStart (): void {
        if (!this.nodeId) { return }
        const raw = this.draft.srgbStart
        const srgbStart = (raw != null && Number.isFinite(raw) && raw >= 16) ? Math.trunc(raw) : undefined
        this.svc.updateNodeConfig(this.nodeId, { srgbStart })
        this.svc.regenerateConfigs()
    }

    applySrgbEnd (): void {
        if (!this.nodeId) { return }
        const raw = this.draft.srgbEnd
        const srgbEnd = (raw != null && Number.isFinite(raw) && raw >= 16) ? Math.trunc(raw) : undefined
        this.svc.updateNodeConfig(this.nodeId, { srgbEnd })
        this.svc.regenerateConfigs()
    }

    applyMplsLdp (): void {
        if (!this.nodeId) { return }
        const mplsLdp = this.draft.mplsLdp === true ? true : undefined
        this.svc.updateNodeConfig(this.nodeId, { mplsLdp })
        this.svc.regenerateConfigs()
    }

    applyTelemetry (): void {
        if (!this.nodeId) { return }
        const telemetryEnabled = this.draft.telemetryEnabled === true ? true : undefined
        this.svc.updateNodeConfig(this.nodeId, { telemetryEnabled })
        this.svc.regenerateConfigs()
    }

    applySerialNumber (): void {
        if (!this.nodeId) { return }
        const serialNumber = (this.draft.serialNumber ?? '').trim() || undefined
        this.svc.updateNodeConfig(this.nodeId, { serialNumber })
    }

    applySourceId (): void {
        if (!this.nodeId) { return }
        const sourceId = (this.draft.sourceId ?? '').trim() || undefined
        this.svc.updateNodeConfig(this.nodeId, { sourceId })
    }

    applyMgmtIp (): void {
        if (!this.nodeId) { return }
        const mgmtIp = (this.draft.mgmtIp ?? '').trim()
        this.svc.updateNodeConfig(this.nodeId, { mgmtIp })
    }

    applyLoopbackIp (): void {
        if (!this.nodeId) { return }
        const loopbackIp = (this.draft.loopbackIp ?? '').trim()
        this.svc.updateNodeConfig(this.nodeId, { loopbackIp })
    }

    applyLoopbackIpv6 (): void {
        if (!this.nodeId) { return }
        const loopbackIpv6 = (this.draft.loopbackIpv6 ?? '').trim()
        this.svc.updateNodeConfig(this.nodeId, { loopbackIpv6 })
    }

    applySshUsername (): void {
        if (!this.nodeId) { return }
        const sshUsername = (this.draft.sshUsername ?? '').trim()
        this.svc.updateNodeConfig(this.nodeId, { sshUsername })
    }

    applySshPort (): void {
        if (!this.nodeId) { return }
        const raw = this.draft.sshPort
        const parsed = typeof raw === 'number' ? raw : Number(raw)
        const valid = Number.isFinite(parsed) ? Math.trunc(parsed) : 22
        const sshPort = valid >= 1 && valid <= 65535 ? valid : 22
        this.draft.sshPort = sshPort
        this.svc.updateNodeConfig(this.nodeId, { sshPort })
        this.cdr.markForCheck()
    }

    applySshPassword (): void {
        if (!this.nodeId) { return }
        this.svc.updateNodeConfig(this.nodeId, { sshPassword: this.sshPassword })
    }

    private _setSshState (ok: boolean, msg: string, output = ''): void {
        this.sshStatusOk = ok
        this.sshStatusMsg = msg
        this.sshOutput = output
        this.cdr.markForCheck()
    }

    private _buildSshRequest (): Omit<NetopsSshRequest, 'password'> | null {
        const hostRaw = (this.draft.mgmtIp ?? this.node?.mgmtIp ?? '').trim()
        const host = hostRaw.split('/')[0].trim()
        if (!host) {
            this._setSshState(false, 'Set Mgmt IP / host before SSH actions')
            return null
        }

        const username = (this.draft.sshUsername ?? this.node?.sshUsername ?? '').trim()
        if (!username) {
            this._setSshState(false, 'Set SSH username before SSH actions')
            return null
        }

        const portRaw = this.draft.sshPort ?? this.node?.sshPort ?? 22
        const parsedPort = typeof portRaw === 'number' ? portRaw : Number(portRaw)
        const portCandidate = Number.isFinite(parsedPort) ? Math.trunc(parsedPort) : 22
        const port = portCandidate >= 1 && portCandidate <= 65535 ? portCandidate : 22

        return { host, port, username, timeoutMs: 8000 }
    }

    async testSshConnection (): Promise<void> {
        if (this.sshBusy) { return }
        const request = this._buildSshRequest()
        if (!request) { return }

        const api = window.netopsAPI
        if (!api?.sshTestConnection) {
            this._setSshState(false, 'SSH API is unavailable in this runtime')
            return
        }

        const password = this.sshPassword
        if (!password.length) {
            this._setSshState(false, 'SSH password is required')
            return
        }

        this.sshBusy = true
        this._setSshState(false, 'Testing SSH connection...')
        try {
            const backend = this._getBackendSvc()
            let result: any
            if (backend?.isConnected) {
                result = await backend.runCommand(request.host, request.port, request.username, password, 'show version')
            } else {
                result = await api.sshTestConnection({ ...request, password })
            }
            this._setSshState(result.ok, result.message, result.output ?? '')
        } catch (err) {
            this._setSshState(false, `SSH test failed: ${(err as Error).message}`)
        } finally {
            this.sshBusy = false
            this.cdr.markForCheck()
        }
    }

    async runShowVersion (): Promise<void> {
        if (this.sshBusy) { return }
        const request = this._buildSshRequest()
        if (!request) { return }

        const api = window.netopsAPI
        if (!api?.sshRunCommand) {
            this._setSshState(false, 'SSH API is unavailable in this runtime')
            return
        }

        const password = this.sshPassword
        if (!password.length) {
            this._setSshState(false, 'SSH password is required')
            return
        }

        // Use vendor-specific show-version command (e.g. cli -c "show version" for Juniper)
        const vendor = this.node?.vendor ?? ''
        const cmds = getVendorCommands(vendor)

        this.sshBusy = true
        this._setSshState(false, `Running "${cmds.showVersion}"...`)
        try {
            const backend = this._getBackendSvc()
            let result: any
            if (backend?.isConnected) {
                result = await backend.runCommand(request.host, request.port, request.username, password, cmds.showVersion)
            } else {
                result = await api.sshRunCommand({
                    host: request.host,
                    port: request.port,
                    username: request.username,
                    password,
                    timeoutMs: request.timeoutMs ?? 15000,
                    command: cmds.showVersion,
                })
            }
            // Network devices may return non-zero exit codes on success —
            // treat any result with output as successful
            const output = result.output ?? ''
            const hasOutput = !!output && output !== '(no output)'
            this._setSshState(result.ok || hasOutput, result.message, output)
        } catch (err) {
            this._setSshState(false, `show version failed: ${(err as Error).message}`)
        } finally {
            this.sshBusy = false
            this.cdr.markForCheck()
        }
    }

    onInfoKeydown (ev: KeyboardEvent, field: 'label' | 'description' | 'image' | 'vendor' | 'model' | 'desiredPortCount' | 'portSuffix' | 'asn' | 'ospfArea' | 'isisLevel' | 'nodeSid' | 'srgbStart' | 'srgbEnd' | 'srv6Locator' | 'mgmtIp' | 'loopbackIp' | 'loopbackIpv6' | 'sshUsername' | 'sshPort' | 'sshPassword' | 'serialNumber' | 'sourceId'): void {
        if (ev.key === 'Enter' && field !== 'description') {
            if (field === 'label')       { this.applyLabel() }
            else if (field === 'image')  { this.applyImage() }
            else if (field === 'vendor') { this.applyVendor() }
            else if (field === 'model') { this.applyModel() }
            else if (field === 'desiredPortCount') { this.applyDesiredPortCount() }
            else if (field === 'portSuffix') { this.applyPortSuffix() }
            else if (field === 'asn') { this.applyAsn() }
            else if (field === 'ospfArea') { this.applyOspfArea() }
            else if (field === 'isisLevel') { this.applyIsisLevel() }
            else if (field === 'nodeSid') { this.applyNodeSid() }
            else if (field === 'srgbStart') { this.applySrgbStart() }
            else if (field === 'srgbEnd') { this.applySrgbEnd() }
            else if (field === 'srv6Locator') { this.applySrv6Locator() }
            else if (field === 'mgmtIp') { this.applyMgmtIp() }
            else if (field === 'loopbackIp') { this.applyLoopbackIp() }
            else if (field === 'loopbackIpv6') { this.applyLoopbackIpv6() }
            else if (field === 'sshUsername') { this.applySshUsername() }
            else if (field === 'sshPort') { this.applySshPort() }
            else if (field === 'sshPassword') { this.applySshPassword() }
            else if (field === 'serialNumber') { this.applySerialNumber() }
            else if (field === 'sourceId') { this.applySourceId() }
        }
    }

    get hasSshPassword (): boolean { return this.sshPassword.length > 0 }

    get showVendorSelector (): boolean {
        return !!this.node && (this.node.type === 'router' || this.node.type === 'switch')
    }

    // ── Server / PC image presets ─────────────────────────────────────────

    readonly serverImagePresets = SERVER_IMAGE_PRESETS

    get showServerImagePresets (): boolean {
        return !!this.node && (this.node.type === 'server' || this.node.type === 'pc')
    }

    /** Preset categories in display order */
    get serverImageCategories (): ServerImageCategory[] {
        const cats = new Set<ServerImageCategory>()
        for (const p of this.serverImagePresets) { cats.add(p.category) }
        if (this.localDockerImageOptions.length > 0) { cats.add('Local Images') }
        return [...cats]
    }

    /** Presets filtered by category */
    serverImagesByCategory (cat: ServerImageCategory): ServerImagePreset[] {
        if (cat === 'Local Images') {
            return this.localDockerImageOptions.map(name => ({
                label: name,
                image: name,
                category: 'Local Images' as ServerImageCategory,
            }))
        }
        return this.serverImagePresets.filter(p => p.category === cat)
    }

    /** Local Docker images filtered to exclude preset images and NOS images */
    get localDockerImageOptions (): string[] {
        const presetImages = new Set(this.serverImagePresets.map(p => p.image))
        const nosPatterns = ['ceos', 'sonic', 'srlinux', 'srl', 'xrd', 'xrv', 'vqfx', 'vjunos', 'crpd', 'vr-', 'vrnetlab']
        return this.localDockerImages.filter(name => {
            if (presetImages.has(name)) { return false }
            const lower = name.toLowerCase()
            return !nosPatterns.some(p => lower.includes(p))
        })
    }

    /** Currently selected preset image value (for dropdown binding) */
    get selectedServerImage (): string {
        const img = (this.draft.image ?? '').trim()
        if (!img) { return '' }
        // Check presets
        if (this.serverImagePresets.some(p => p.image === img)) { return img }
        // Check local images
        if (this.localDockerImages.includes(img)) { return img }
        return ''
    }

    onServerImageSelect (image: string): void {
        if (!this.nodeId) { return }
        this.draft.image = image || ''
        this.svc.updateNodeConfig(this.nodeId, { image: image || '' })
        this.cdr.markForCheck()
    }

    /** Description hint for the currently selected server image preset */
    get selectedServerImageDesc (): string {
        const img = (this.draft.image ?? '').trim()
        return this.serverImagePresets.find(p => p.image === img)?.description ?? ''
    }

    // ── Host Port (physical interface) ───────────────────────────────────

    hostInterfaces: Array<{ name: string; state: string }> = []
    hostInterfacesLoading = false

    get isHostNode (): boolean { return this.node?.type === 'host' }

    get defaultNodeSize (): number {
        if (!this.node) { return 90 }
        return (this.node.type === 'host' || this.node.type === 'bridge') ? 50 : 90
    }

    onNodeSizeChange (value: string): void {
        if (!this.nodeId) { return }
        const size = Number(value)
        if (isNaN(size)) { return }
        this.draft.width = size
        this.draft.height = size
        this.svc.updateNodeConfig(this.nodeId, { width: size, height: size })
    }

    async fetchHostInterfaces (autoPopulate = false): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.clabListHostInterfaces) { console.warn('[node-props] clabListHostInterfaces API not available'); return }
        this.hostInterfacesLoading = true
        this.cdr.markForCheck()
        try {
            // Pass the node's assigned serverId so we query the correct server
            const serverId = this.node?.serverId || 'local'
            const res = await api.clabListHostInterfaces({ serverId })
            this.hostInterfaces = res?.ok ? (res.interfaces ?? []) : []
        } catch { this.hostInterfaces = [] }
        this.hostInterfacesLoading = false
        if (autoPopulate && this.hostInterfaces.length) {
            this._autoPopulateHostPorts()
        }
        this.cdr.markForCheck()
    }

    /** Remove all links and ports for this host node — used when switching compute hosts. */
    private _clearHostPortsAndLinks (): void {
        if (!this.nodeId) { return }
        // Remove all links connected to this node
        const linksToRemove = this.svc.topology.links.filter(
            l => l.sourceNodeId === this.nodeId || l.targetNodeId === this.nodeId
        )
        for (const link of linksToRemove) {
            this.svc.removeLink(link.id)
        }
        // Clear all ports
        this.svc.updateNodeConfig(this.nodeId, { ports: [] } as any)
        this.node = this.svc.getNode(this.nodeId) ?? null
    }

    /** Replace the host node's ports with interfaces fetched from the compute host.
     *  Preserves any ports that are currently linked. */
    private _autoPopulateHostPorts (): void {
        if (!this.nodeId || !this.node || !this.hostInterfaces.length) { return }

        // Find ports that are in use (have links referencing them)
        const linkedPortIds = new Set<string>()
        for (const link of this.svc.topology.links) {
            if (link.sourceNodeId === this.nodeId) { linkedPortIds.add(link.sourcePortId) }
            if (link.targetNodeId === this.nodeId) { linkedPortIds.add(link.targetPortId) }
        }

        // Keep linked ports, replace everything else with fetched interfaces
        const linkedPorts = this.node.ports.filter(p => linkedPortIds.has(p.id))
        const linkedNames = new Set(linkedPorts.map(p => p.label))

        const newPorts = [...linkedPorts]
        for (const iface of this.hostInterfaces) {
            if (linkedNames.has(iface.name)) { continue } // already kept as a linked port
            newPorts.push({ id: `nic${newPorts.length}`, label: iface.name, enabled: iface.state === 'up' })
        }

        this.svc.updateNodeConfig(this.nodeId, { ports: newPorts } as any)
        this._loadNode()
    }

    /** Get server display name for the current host node */
    get hostServerLabel (): string {
        if (!this.node?.serverId) { return 'active server' }
        const s = this.clabServers.find(sv => sv.id === this.node!.serverId)
        return s ? `${s.name}${s.host ? ' (' + s.host + ')' : ''}` : 'active server'
    }

    onHostInterfaceChange (value: string): void {
        if (!this.nodeId) { return }
        this.draft.hostInterface = value || ''
        this.svc.updateNodeConfig(this.nodeId, { hostInterface: value || '' })
        // Also update the first port label to show the selected interface name
        if (value && this.node?.ports?.length) {
            const port = this.node.ports[0]
            this.svc.updatePort(this.nodeId, port.id, { label: value })
        }
        this.cdr.markForCheck()
    }

    /** Add a new host interface port to this host node */
    addHostPort (): void {
        if (!this.nodeId || !this.node) { return }
        const idx = this.node.ports.length
        const newPort = { id: `nic${idx}`, label: `NIC${idx}`, enabled: true }
        const updatedPorts = [...this.node.ports, newPort]
        this.svc.updateNodeConfig(this.nodeId, { ports: updatedPorts } as any)
        this._loadNode()  // refresh the view
    }

    /** Remove the last host interface port (minimum 1) */
    removeHostPort (): void {
        if (!this.nodeId || !this.node || this.node.ports.length <= 1) { return }
        // Check if the last port is used in any link
        const lastPort = this.node.ports[this.node.ports.length - 1]
        const isUsed = this.svc.topology.links.some(
            l => (l.sourceNodeId === this.nodeId && l.sourcePortId === lastPort.id) ||
                 (l.targetNodeId === this.nodeId && l.targetPortId === lastPort.id),
        )
        if (isUsed) { return } // don't remove ports that are in use
        const updatedPorts = this.node.ports.slice(0, -1)
        this.svc.updateNodeConfig(this.nodeId, { ports: updatedPorts } as any)
        this._loadNode()
    }

    /** Check if an interface name is already assigned to another port on this node */
    isIfaceUsedByOtherPort (ifaceName: string, currentPortId: string): boolean {
        if (!this.node || !ifaceName) { return false }
        return this.node.ports.some(p => p.id !== currentPortId && p.label === ifaceName)
    }

    /** Update a specific host port's interface assignment */
    onHostPortInterfaceChange (portId: string, value: string): void {
        if (!this.nodeId) { return }
        // Update port label to the interface name
        this.svc.updatePort(this.nodeId, portId, { label: value || 'NIC' })
        // If this is the first port, also update hostInterface for backward compat
        if (this.node?.ports?.[0]?.id === portId) {
            this.draft.hostInterface = value || ''
            this.svc.updateNodeConfig(this.nodeId, { hostInterface: value || '' })
        }
        this.cdr.markForCheck()
    }

    // ── Bridge node ──────────────────────────────────────────────────────

    bridgeListForNode: Array<{ name: string; type: string; state: string }> = []
    bridgeListLoading = false

    get isBridgeNode (): boolean { return this.node?.type === 'bridge' }

    /** True when node has IGP (ISIS/OSPF) configured — SR fields are only relevant then */
    get hasIgpRouting (): boolean {
        return !!(this.node && (this.node.isisLevel != null || this.node.ospfArea != null))
    }

    isBridgeAlreadyAdded (name: string): boolean {
        return !!this.node?.ports.some(p => p.label === name)
    }

    async fetchBridgeList (): Promise<void> {
        const api = (window as any).netopsAPI
        if (!api?.bridgeList) { return }
        this.bridgeListLoading = true
        this.cdr.markForCheck()
        try {
            const serverId = this.node?.serverId || 'local'
            const res = await api.bridgeList({ serverId })
            this.bridgeListForNode = res?.ok ? (res.bridges ?? []) : []
        } catch { this.bridgeListForNode = [] }
        this.bridgeListLoading = false
        this.cdr.markForCheck()
    }

    onBridgeNameChange (value: string): void {
        if (!this.nodeId) { return }
        this.draft.bridgeName = value || ''
        // Auto-detect type from bridge list
        const br = this.bridgeListForNode.find(b => b.name === value)
        const bridgeType = (br?.type as any) || 'linux'
        this.draft.bridgeType = bridgeType
        this.svc.updateNodeConfig(this.nodeId, { bridgeName: value || '', bridgeType })
        this.cdr.markForCheck()
    }

    /** Update a specific bridge port's bridge assignment (per-port, like host interfaces) */
    onBridgePortChange (portId: string, value: string): void {
        if (!this.nodeId) { return }
        this.svc.updatePort(this.nodeId, portId, { label: value || 'br' })
        // If first port, also update bridgeName for backward compat
        if (this.node?.ports?.[0]?.id === portId) {
            const br = this.bridgeListForNode.find(b => b.name === value)
            const bridgeType = (br?.type as any) || 'linux'
            this.draft.bridgeName = value || ''
            this.draft.bridgeType = bridgeType
            this.svc.updateNodeConfig(this.nodeId, { bridgeName: value || '', bridgeType })
        }
        this.cdr.markForCheck()
    }

    /** Check if a bridge is already assigned to another port on this node */
    isBridgeUsedByOtherPort (bridgeName: string, currentPortId: string): boolean {
        if (!this.node || !bridgeName) { return false }
        return this.node.ports.some(p => p.id !== currentPortId && p.label === bridgeName)
    }

    /** Add another bridge port */
    addBridgePort (): void {
        if (!this.nodeId || !this.node) { return }
        const idx = this.node.ports.length
        const newPort = { id: `br${idx}`, label: `br${idx}`, enabled: true }
        const updatedPorts = [...this.node.ports, newPort]
        this.svc.updateNodeConfig(this.nodeId, { ports: updatedPorts } as any)
        this._loadNode()
    }

    /** Remove the last bridge port (minimum 1) */
    removeBridgePort (): void {
        if (!this.nodeId || !this.node || this.node.ports.length <= 1) { return }
        const lastPort = this.node.ports[this.node.ports.length - 1]
        const isUsed = this.svc.topology.links.some(
            l => (l.sourceNodeId === this.nodeId && l.sourcePortId === lastPort.id) ||
                 (l.targetNodeId === this.nodeId && l.targetPortId === lastPort.id),
        )
        if (isUsed) { return }
        const updatedPorts = this.node.ports.slice(0, -1)
        this.svc.updateNodeConfig(this.nodeId, { ports: updatedPorts } as any)
        this._loadNode()
    }

    get vendorOptionsForNode (): string[] {
        const current = (this.draft.vendor ?? this.node?.vendor ?? '').trim()
        if (!current) { return this.vendorOptions }
        const exists = this.vendorOptions.some(v => v.toLowerCase() === current.toLowerCase())
        return exists ? this.vendorOptions : [current, ...this.vendorOptions]
    }

    /** Show device family selector for any vendor that has families defined */
    get showDeviceFamilySelector (): boolean {
        if (!this.showVendorSelector) { return false }
        const vendor = (this.draft.vendor ?? this.node?.vendor ?? '').trim().toLowerCase()
        return (VENDOR_DEVICE_FAMILIES[vendor]?.length ?? 0) > 0
    }

    /** Placeholder text for the empty device-type option */
    get deviceFamilyPlaceholder (): string {
        const vendor = (this.draft.vendor ?? this.node?.vendor ?? '').trim().toLowerCase()
        if (vendor === 'juniper') { return 'None (cRPD — recommended for macOS)' }
        return 'Select device type'
    }

    /** Device families for the current vendor */
    get deviceFamilyOptions (): SwitchFamily[] {
        const vendor = (this.draft.vendor ?? this.node?.vendor ?? '').trim().toLowerCase()
        return VENDOR_DEVICE_FAMILIES[vendor] ?? []
    }

    /** Show model dropdown when the current vendor:family has predefined model profiles */
    get showVendorModelDropdown (): boolean {
        if (!this.showDeviceFamilySelector) { return false }
        const family = this._sanitizeSwitchFamily(this.draft.switchFamily)
        if (!family) { return false }
        return (this.vendorModelProfiles.length) > 0
    }

    /** Model profiles for the current vendor:family */
    get vendorModelProfiles (): VendorModelProfile[] {
        const vendor = (this.draft.vendor ?? this.node?.vendor ?? '').trim().toLowerCase()
        const family = this._sanitizeSwitchFamily(this.draft.switchFamily)
        if (!vendor || !family) { return [] }
        return VENDOR_MODEL_PROFILES_MAP[`${vendor}:${family}`] ?? []
    }

    /** Show model text input when a family is selected but has no predefined profiles */
    get showVendorModelTextInput (): boolean {
        if (!this.showDeviceFamilySelector) { return false }
        const family = this._sanitizeSwitchFamily(this.draft.switchFamily)
        if (!family) { return false }
        return !this.showVendorModelDropdown
    }

    /** Description for the currently selected model profile */
    get selectedVendorModelDescription (): string {
        if (!this.showVendorModelDropdown) { return '' }
        const model = this._sanitizeModel(this.draft.model)
        if (!model) { return '' }
        const profiles = this.vendorModelProfiles
        return profiles.find(p => p.model.toLowerCase() === model.toLowerCase())?.description ?? ''
    }

    /** Placeholder for model text input based on vendor+family */
    get vendorModelTextPlaceholder (): string {
        const vendor = (this.draft.vendor ?? this.node?.vendor ?? '').trim().toLowerCase()
        const family = this._sanitizeSwitchFamily(this.draft.switchFamily)
        if (vendor === 'juniper' && family === 'EX') { return 'e.g. EX4400-48T' }
        if (vendor === 'juniper' && family === 'MX') { return 'e.g. MX204, MX960' }
        if (vendor === 'juniper' && family === 'PTX') { return 'e.g. PTX10001, PTX10008' }
        if (vendor === 'juniper' && family === 'PTX-EVO') { return 'e.g. PTX10003 (vJunos Evolved)' }
        if (vendor === 'juniper' && family === 'ACX') { return 'e.g. ACX7100, ACX7509' }
        return `e.g. ${family || 'device'} model`
    }

    /** Containerlab kind + image hint for Juniper device families */
    get clabKindHint (): string {
        const vendor = (this.draft.vendor ?? this.node?.vendor ?? '').trim().toLowerCase()
        if (vendor !== 'juniper') { return '' }
        const family = this._sanitizeSwitchFamily(this.draft.switchFamily)
        if (!family) { return '' }
        const model = this._sanitizeModel(this.draft.model).toUpperCase()
        const customImage = (this.draft.image ?? '').trim()

        interface KindInfo { kind: string; image: string; boot: string }
        const familyMap: Record<string, KindInfo> = {
            QFX: { kind: 'juniper_vqfx',          image: 'vrnetlab/vr-vqfx:latest',          boot: '~7 min' },
            EX:  { kind: 'juniper_vjunosswitch',   image: 'vrnetlab/vr-vjunosswitch:latest',  boot: '~15 min' },
            MX:  { kind: 'juniper_vjunosrouter',   image: 'vrnetlab/vr-vjunosrouter:latest',  boot: '~15 min' },
            PTX: { kind: 'juniper_vjunosrouter',   image: 'vrnetlab/vr-vjunosrouter:latest',  boot: '~15 min' },
            'PTX-EVO': { kind: 'juniper_vjunosevolved', image: 'vrnetlab/juniper_vjunosevolved:latest', boot: '~15 min' },
            ACX: { kind: 'juniper_vjunosrouter',   image: 'vrnetlab/vr-vjunosrouter:latest',  boot: '~15 min' },
        }
        const info = familyMap[family]
        if (!info) { return '' }

        // If no model selected yet, show family-level hint
        if (!model) {
            return `Containerlab: ${info.kind} · Image: ${customImage || info.image} · Boot: ${info.boot}`
        }
        return `Containerlab: ${info.kind} · Image: ${customImage || info.image} · Boot: ${info.boot}`
    }

    // Backward compat aliases used by Juniper QFX-specific code paths
    get showSwitchFamilySelector (): boolean { return this.showDeviceFamilySelector }
    get showQfxModelSelector (): boolean {
        return this.showVendorModelDropdown
            && (this.draft.vendor ?? this.node?.vendor ?? '').trim().toLowerCase() === 'juniper'
            && this._sanitizeSwitchFamily(this.draft.switchFamily) === 'QFX'
    }

    // ── Ports tab ───────────────────────────────────────────────────────────

    applyPortIp (portId: string): void {
        if (!this.nodeId) { return }
        this.svc.updatePort(this.nodeId, portId, {
            ipAddress: this.portDrafts[portId]?.ipAddress ?? '',
        })
    }

    applyPortIpv6 (portId: string): void {
        if (!this.nodeId) { return }
        this.svc.updatePort(this.nodeId, portId, {
            ipv6Address: this.portDrafts[portId]?.ipv6Address ?? '',
        })
    }

    applyPortDesc (portId: string): void {
        if (!this.nodeId) { return }
        this.svc.updatePort(this.nodeId, portId, {
            description: this.portDrafts[portId]?.description ?? '',
        })
    }

    applyPortSpeed (portId: string, speed: PortSpeed | undefined): void {
        if (!this.nodeId || !this.node) { return }
        const port = this.node.ports.find(p => p.id === portId)
        if (port && speed && !this._isSpeedAllowedForPort(port, speed)) {
            this.portDrafts[portId] = { ...this.portDrafts[portId], speed: undefined }
            this.portGenMsg = `Speed ${speed} is not valid for ${port.label} on selected model`
            this.svc.updatePort(this.nodeId, portId, { speed: undefined })
            this.cdr.markForCheck()
            return
        }
        this.portDrafts[portId] = { ...this.portDrafts[portId], speed }
        this.svc.updatePort(this.nodeId, portId, { speed })
        this.cdr.markForCheck()
    }

    applyPortVlan (portId: string): void {
        if (!this.nodeId) { return }
        // Only apply access VLAN when not in trunk mode
        if (this.portDrafts[portId]?.vlanMode === 'trunk') { return }
        const raw = this.portDrafts[portId]?.vlan
        const parsed = typeof raw === 'number' ? raw : Number(raw)
        const vlan = Number.isFinite(parsed) && parsed >= 1 && parsed <= 4094
            ? Math.trunc(parsed) : undefined
        this.portDrafts[portId] = { ...this.portDrafts[portId], vlan }
        this.svc.updatePort(this.nodeId, portId, { vlan })
        this.cdr.markForCheck()
    }

    applyPortVlanMode (portId: string, mode: string): void {
        if (!this.nodeId) { return }
        const vlanMode: PortVlanMode | undefined = mode === 'trunk' ? 'trunk' : undefined
        this.portDrafts[portId] = { ...this.portDrafts[portId], vlanMode }
        this.svc.updatePort(this.nodeId, portId, { vlanMode })
        this.cdr.markForCheck()
    }

    applyTrunkNativeVlan (portId: string): void {
        if (!this.nodeId) { return }
        const raw = this.portDrafts[portId]?.trunkNativeVlan
        const parsed = typeof raw === 'number' ? raw : Number(raw)
        const trunkNativeVlan = Number.isFinite(parsed) && parsed >= 1 && parsed <= 4094
            ? Math.trunc(parsed) : undefined
        this.portDrafts[portId] = { ...this.portDrafts[portId], trunkNativeVlan }
        this.svc.updatePort(this.nodeId, portId, { trunkNativeVlan })
        this.cdr.markForCheck()
    }

    applyTrunkAllowedVlans (portId: string): void {
        if (!this.nodeId) { return }
        const raw = (this.portDrafts[portId]?.trunkAllowedVlans ?? '').trim()
        // Support "all" keyword
        if (raw.toLowerCase() === 'all') {
            this.portDrafts[portId] = { ...this.portDrafts[portId], trunkAllowedVlans: 'all' }
            this.svc.updatePort(this.nodeId, portId, { trunkAllowedVlans: 'all' })
            this.cdr.markForCheck()
            return
        }
        const parsed = parseVlanList(raw)
        const trunkAllowedVlans = parsed.length ? compactVlanList(parsed) : undefined
        this.portDrafts[portId] = { ...this.portDrafts[portId], trunkAllowedVlans: trunkAllowedVlans ?? '' }
        this.svc.updatePort(this.nodeId, portId, { trunkAllowedVlans })
        this.cdr.markForCheck()
    }

    isPortTrunk (portId: string): boolean {
        return this.portDrafts[portId]?.vlanMode === 'trunk'
    }

    isTrunkAllowAll (portId: string): boolean {
        return (this.portDrafts[portId]?.trunkAllowedVlans ?? '').toLowerCase() === 'all'
    }

    toggleTrunkAllowAll (portId: string, checked: boolean): void {
        if (!this.nodeId) { return }
        const trunkAllowedVlans = checked ? 'all' : undefined
        this.portDrafts[portId] = { ...this.portDrafts[portId], trunkAllowedVlans: trunkAllowedVlans ?? '' }
        this.svc.updatePort(this.nodeId, portId, { trunkAllowedVlans })
        this.cdr.markForCheck()
    }

    // ── VLAN table CRUD ────────────────────────────────────────────────────

    addVlan (): void {
        if (!this.nodeId || !this.node) { return }
        const id = this.newVlanId
        const name = (this.newVlanName ?? '').trim()
        if (!id || id < 1 || id > 4094 || !name) { return }
        if (this.vlanDrafts.some(v => v.id === id)) { return }
        this.vlanDrafts = [...this.vlanDrafts, { id, name }]
        this.svc.updateNodeConfig(this.nodeId, { vlans: [...this.vlanDrafts] })
        this.newVlanId = null
        this.newVlanName = ''
        this.cdr.markForCheck()
    }

    removeVlan (vlanId: number): void {
        if (!this.nodeId) { return }
        this.vlanDrafts = this.vlanDrafts.filter(v => v.id !== vlanId)
        this.svc.updateNodeConfig(this.nodeId, { vlans: [...this.vlanDrafts] })
        this.cdr.markForCheck()
    }

    applyVlanName (vlanId: number, name: string): void {
        if (!this.nodeId) { return }
        this.vlanDrafts = this.vlanDrafts.map(v =>
            v.id === vlanId ? { ...v, name: name.trim() } : v,
        )
        this.svc.updateNodeConfig(this.nodeId, { vlans: [...this.vlanDrafts] })
        this.cdr.markForCheck()
    }

    generateVlans (): void {
        if (!this.nodeId || !this.node) { return }
        const start = this.vlanGenStart
        const end = this.vlanGenEnd
        const prefix = (this.vlanGenPrefix ?? 'VLAN').trim() || 'VLAN'
        const step = Math.max(1, Math.trunc(this.vlanGenStep ?? 1))
        if (!start || !end || start < 1 || end > 4094 || start > end) { return }

        const existingIds = new Set(this.vlanDrafts.map(v => v.id))
        const newVlans: VlanDefinition[] = []
        for (let id = start; id <= end; id += step) {
            if (id > 4094) { break }
            if (existingIds.has(id)) { continue }
            newVlans.push({ id, name: `${prefix}${id}` })
        }
        if (!newVlans.length) { return }

        this.vlanDrafts = [...this.vlanDrafts, ...newVlans]
        this.svc.updateNodeConfig(this.nodeId, { vlans: [...this.vlanDrafts] })
        this.vlanGenStart = null
        this.vlanGenEnd = null
        this.cdr.markForCheck()
    }

    clearAllVlans (): void {
        if (!this.nodeId) { return }
        this.vlanDrafts = []
        this.svc.updateNodeConfig(this.nodeId, { vlans: [] })
        this.cdr.markForCheck()
    }

    // ── VLAN templates ────────────────────────────────────────────────────

    get filteredVlanTemplates (): VlanTemplate[] {
        if (this.vlanTemplateFilter === 'all') { return this.vlanTemplates }
        return this.vlanTemplates.filter(t => t.category === this.vlanTemplateFilter)
    }

    toggleVlanTemplates (): void {
        this.showVlanTemplates = !this.showVlanTemplates
        this.cdr.markForCheck()
    }

    setVlanTemplateFilter (filter: 'all' | VlanTemplateCategory): void {
        this.vlanTemplateFilter = filter
        this.cdr.markForCheck()
    }

    loadVlanTemplate (tpl: VlanTemplate): void {
        if (!this.nodeId) { return }
        if (this.vlanDrafts.length > 0) {
            const ok = confirm(
                `This will replace the current ${this.vlanDrafts.length} VLAN(s) with the "${tpl.name}" template (${tpl.vlans.length} VLANs). Continue?`,
            )
            if (!ok) { return }
        }
        this.vlanDrafts = tpl.vlans.map(v => ({ ...v }))
        this.svc.updateNodeConfig(this.nodeId, { vlans: [...this.vlanDrafts] })
        this.showVlanTemplates = false
        this.cdr.markForCheck()
    }

    togglePortEnabled (portId: string): void {
        if (!this.nodeId) { return }
        const current = this.portDrafts[portId]?.enabled ?? true
        this.portDrafts[portId] = { ...this.portDrafts[portId], enabled: !current }
        this.svc.updatePort(this.nodeId, portId, { enabled: !current })
        this.cdr.markForCheck()
    }

    portIsLinked (portId: string): boolean {
        return portId in this.portLinkMap
    }

    private _sanitizeChannelCount (value: unknown, fallback = 2): number {
        const parsed = typeof value === 'number' ? value : Number(value)
        if (!Number.isFinite(parsed)) { return fallback }
        return Math.max(2, Math.min(64, Math.trunc(parsed)))
    }

    private _nextPortId (usedIds: Set<string>, baseId: string): string {
        let id = baseId
        let suffix = 1
        while (usedIds.has(id)) {
            id = `${baseId}_${suffix}`
            suffix += 1
        }
        usedIds.add(id)
        return id
    }

    private _channelIndexFromLabel (label: string): number | null {
        const sep = label.indexOf(':')
        if (sep <= 0) { return null }
        const parsed = Number(label.slice(sep + 1))
        if (!Number.isFinite(parsed)) { return null }
        const idx = Math.trunc(parsed)
        return idx >= 0 ? idx : null
    }

    private _portBaseLabel (label: string): string {
        const sep = label.indexOf(':')
        return sep > 0 ? label.slice(0, sep).trim() : label.trim()
    }

    private _groupPortsForBase (baseLabel: string): NodePort[] {
        if (!this.node) { return [] }
        return this.node.ports.filter(p =>
            p.label === baseLabel || p.label.startsWith(`${baseLabel}:`),
        )
    }

    canChannelizePort (port: NodePort): boolean {
        const baseLabel = this._portBaseLabel(port.label).toLowerCase()
        if (!baseLabel.startsWith('et')) { return false }
        const forcedChannels = this._speedBreakoutChannelsForPort(port)

        // Show breakout controls only on the parent row:
        // - unchannelized parent (no ':')
        // - channelized parent representative (:0)
        const channelIdx = this._channelIndexFromLabel(port.label)
        if (channelIdx !== null && channelIdx !== 0) { return false }
        if (forcedChannels === 1) { return this.hasChannelizedGroup(port) }
        return true
    }

    hasChannelizedGroup (port: NodePort): boolean {
        const baseLabel = this._portBaseLabel(port.label)
        const group = this._groupPortsForBase(baseLabel)
        return group.some(p => this._channelIndexFromLabel(p.label) !== null)
    }

    channelizePort (portId: string): void {
        if (!this.nodeId || !this.node) { return }
        const idx = this.node.ports.findIndex(p => p.id === portId)
        if (idx < 0) { return }

        const source = this.node.ports[idx]
        if (!this.canChannelizePort(source)) {
            this.portGenMsg = 'Channelization is enabled only for et parent ports (set Port Suffix to et)'
            this.cdr.markForCheck()
            return
        }

        const forcedChannels = this._speedBreakoutChannelsForPort(source)
        if (forcedChannels === 1) {
            if (this.hasChannelizedGroup(source)) {
                this.resetChannelizedPort(portId)
                return
            }
            this.portGenMsg = `${source.label} at ${source.speed ?? 'Auto'} does not support breakout channels`
            this.cdr.markForCheck()
            return
        }

        let channelCount = forcedChannels && forcedChannels > 1
            ? forcedChannels
            : this._sanitizeChannelCount(this.portChannelDrafts[portId], 2)
        this.portChannelDrafts[portId] = channelCount

        const baseLabel = source.label.includes(':')
            ? source.label.split(':')[0].trim()
            : source.label.trim()
        if (!baseLabel) { return }

        const groupPorts = this.node.ports.filter(p =>
            p.label === baseLabel || p.label.startsWith(`${baseLabel}:`),
        )
        if (!groupPorts.length) { return }

        const existingByChannel = new Map<number, NodePort>()
        for (const p of groupPorts) {
            const ch = this._channelIndexFromLabel(p.label)
            existingByChannel.set(ch ?? 0, p)
        }

        const linkedIds = new Set<string>()
        for (const link of this.svc.topology.links) {
            if (link.sourceNodeId === this.nodeId) { linkedIds.add(link.sourcePortId) }
            if (link.targetNodeId === this.nodeId) { linkedIds.add(link.targetPortId) }
        }

        let minChannelsRequired = 1
        for (const [ch, p] of existingByChannel) {
            if (linkedIds.has(p.id)) {
                minChannelsRequired = Math.max(minChannelsRequired, ch + 1)
            }
        }
        let adjustedForLinks = false
        if (channelCount < minChannelsRequired) {
            channelCount = minChannelsRequired
            this.portChannelDrafts[portId] = channelCount
            adjustedForLinks = true
        }

        const seedPort = existingByChannel.get(0) ?? source
        const usedIds = new Set(this.node.ports.map(p => p.id))
        for (const p of groupPorts) { usedIds.delete(p.id) }

        const channelized: NodePort[] = []
        for (let channel = 0; channel < channelCount; channel++) {
            const existing = existingByChannel.get(channel)
            const id = existing?.id
                ?? (channel === 0 ? seedPort.id : this._nextPortId(usedIds, `${seedPort.id}_ch${channel}`))

            channelized.push({
                id,
                label: `${baseLabel}:${channel}`,
                enabled: existing?.enabled ?? seedPort.enabled,
                ipAddress: existing?.ipAddress ?? '',
                description: existing?.description ?? '',
                speed: existing?.speed ?? seedPort.speed,
                vlan: existing?.vlan ?? seedPort.vlan,
                vlanMode: existing?.vlanMode ?? seedPort.vlanMode,
                trunkNativeVlan: existing?.trunkNativeVlan ?? seedPort.trunkNativeVlan,
                trunkAllowedVlans: existing?.trunkAllowedVlans ?? seedPort.trunkAllowedVlans,
            })
        }

        const groupIds = new Set(groupPorts.map(p => p.id))
        const ports: NodePort[] = []
        let inserted = false
        for (const p of this.node.ports) {
            if (groupIds.has(p.id)) {
                if (!inserted) {
                    ports.push(...channelized)
                    inserted = true
                }
                continue
            }
            ports.push(p)
        }
        if (!inserted) { ports.push(...channelized) }

        this.draft.desiredPortCount = ports.length
        const update: Partial<TopologyNode> = { ports, desiredPortCount: ports.length }
        const vendor = (this.draft.vendor ?? this.node.vendor ?? '').trim()
        if (vendor) {
            const startupConfig = this._buildVendorStartupConfig(vendor, ports)
            this.draft.startupConfig = startupConfig
            update.startupConfig = startupConfig
        }
        this.svc.updateNodeConfig(this.nodeId, update)
        const forceMsg = forcedChannels && forcedChannels > 1
            ? ` (auto from ${source.speed})`
            : ''
        this.portGenMsg = adjustedForLinks
            ? `Channelized ${baseLabel} into ${channelCount} ports (linked channels preserved)`
            : `Channelized ${baseLabel} into ${channelCount} ports${forceMsg}`
        this.cdr.markForCheck()
    }

    resetChannelizedPort (portId: string): void {
        if (!this.nodeId || !this.node) { return }
        const source = this.node.ports.find(p => p.id === portId)
        if (!source) { return }

        const baseLabel = this._portBaseLabel(source.label)
        const groupPorts = this._groupPortsForBase(baseLabel)
        if (!groupPorts.length) { return }

        const linkedIds = new Set<string>()
        for (const link of this.svc.topology.links) {
            if (link.sourceNodeId === this.nodeId) { linkedIds.add(link.sourcePortId) }
            if (link.targetNodeId === this.nodeId) { linkedIds.add(link.targetPortId) }
        }

        const linkedChildCount = groupPorts.filter(p => {
            const channelIdx = this._channelIndexFromLabel(p.label)
            return channelIdx !== null && channelIdx > 0 && linkedIds.has(p.id)
        }).length
        if (linkedChildCount > 0) {
            this.portGenMsg = `Cannot reset ${baseLabel}: unlink ${linkedChildCount} breakout channel(s) first`
            this.cdr.markForCheck()
            return
        }

        const primary = groupPorts.find(p => this._channelIndexFromLabel(p.label) === 0)
            ?? groupPorts.find(p => p.label === baseLabel)
            ?? source

        const groupIds = new Set(groupPorts.map(p => p.id))
        const ports: NodePort[] = []
        let inserted = false
        for (const p of this.node.ports) {
            if (groupIds.has(p.id)) {
                if (!inserted) {
                    ports.push({
                        id: primary.id,
                        label: baseLabel,
                        enabled: primary.enabled,
                        ipAddress: primary.ipAddress,
                        description: primary.description,
                        speed: primary.speed,
                        vlan: primary.vlan,
                        vlanMode: primary.vlanMode,
                        trunkNativeVlan: primary.trunkNativeVlan,
                        trunkAllowedVlans: primary.trunkAllowedVlans,
                    })
                    inserted = true
                }
                continue
            }
            ports.push(p)
        }
        if (!inserted) {
            ports.push({
                id: primary.id,
                label: baseLabel,
                enabled: primary.enabled,
                ipAddress: primary.ipAddress,
                description: primary.description,
                speed: primary.speed,
                vlan: primary.vlan,
                vlanMode: primary.vlanMode,
                trunkNativeVlan: primary.trunkNativeVlan,
                trunkAllowedVlans: primary.trunkAllowedVlans,
            })
        }

        this.portChannelDrafts[primary.id] = 0
        this.draft.desiredPortCount = ports.length
        const update: Partial<TopologyNode> = { ports, desiredPortCount: ports.length }
        const vendor = (this.draft.vendor ?? this.node.vendor ?? '').trim()
        if (vendor) {
            const startupConfig = this._buildVendorStartupConfig(vendor, ports)
            this.draft.startupConfig = startupConfig
            update.startupConfig = startupConfig
        }
        this.svc.updateNodeConfig(this.nodeId, update)
        this.portGenMsg = `Reset channelization on ${baseLabel}`
        this.cdr.markForCheck()
    }

    // ── Add / remove ports ───────────────────────────────────────────────────

    newPortLabel = ''

    addPort (): void {
        if (!this.nodeId || !this.node) { return }
        const label = this.newPortLabel.trim()
        if (!label) { return }
        // Validate: reject duplicate port labels
        const exists = this.node.ports.some(p => p.label.toLowerCase() === label.toLowerCase())
        if (exists) {
            this.portGenMsg = `Port "${label}" already exists — use a unique name`
            this.cdr.markForCheck()
            return
        }
        this.svc.addPort(this.nodeId, label)
        this.newPortLabel = ''
        this.portGenMsg = ''
        this.cdr.markForCheck()
    }

    removePort (portId: string): void {
        if (!this.nodeId) { return }
        this.svc.removePort(this.nodeId, portId)
    }

    // ── Config tab ──────────────────────────────────────────────────────────

    applyStartupConfig (): void {
        if (!this.nodeId) { return }
        // Mark as 'manual' so _regenerateConfigs won't overwrite user edits
        this.svc.updateNodeConfig(this.nodeId, { startupConfig: this.draft.startupConfig ?? '', configSource: 'manual' })
    }

    clearStartupConfig (): void {
        if (!this.nodeId) { return }
        this.draft.startupConfig = ''
        this.svc.updateNodeConfig(this.nodeId, { startupConfig: '' })
        this.cdr.markForCheck()
    }

    copyStartupConfig (): void {
        const cfg = this.draft.startupConfig?.trim()
        if (!cfg) { return }
        navigator.clipboard.writeText(cfg).catch(() => {})
    }

    downloadStartupConfig (): void {
        const cfg = this.draft.startupConfig?.trim()
        if (!cfg) { return }
        const name = (this.node?.label ?? 'node').replace(/\s+/g, '_')
        const blob = new Blob([cfg], { type: 'text/plain' })
        const url  = URL.createObjectURL(blob)
        const a    = document.createElement('a')
        a.href = url
        a.download = `${name}_startup.cfg`
        a.click()
        setTimeout(() => URL.revokeObjectURL(url), 1000)
    }

    // ── Config editor in new window ───────────────────────────────────────────

    private _configWindow: Window | null = null
    private _configMessageHandler: ((e: MessageEvent) => void) | null = null

    openConfigWindow (): void {
        // If already open, focus it
        if (this._configWindow && !this._configWindow.closed) {
            this._configWindow.focus()
            return
        }

        const label = this.node?.label ?? 'Node'
        const cfg = this.draft.startupConfig ?? ''

        const win = window.open('', '_blank', 'width=900,height=700,menubar=no,toolbar=no')
        if (!win) { return }
        this._configWindow = win

        // Build the static HTML (no inline scripts / onclick — CSP blocks those)
        win.document.write(this._buildConfigEditorHtml(label, cfg))
        win.document.close()
        win.document.title = `Config — ${label}`

        // Attach all event listeners programmatically from the parent context.
        // This avoids CSP inline-script restrictions in the child window.
        const doc = win.document
        const cfgEl  = doc.getElementById('cfg') as HTMLTextAreaElement | null
        const status = doc.getElementById('status')
        const btnCopy  = doc.getElementById('btn-copy')
        const btnSave  = doc.getElementById('btn-save')
        const btnClose = doc.getElementById('btn-close')

        const flashStatus = (msg: string) => {
            if (!status) { return }
            status.textContent = msg
            setTimeout(() => { status.textContent = 'Edit config and click "Save to Topology" to apply changes.' }, 2000)
        }

        btnCopy?.addEventListener('click', () => {
            if (!cfgEl) { return }
            navigator.clipboard.writeText(cfgEl.value)
                .then(() => flashStatus('Copied to clipboard.'))
                .catch(() => {
                    // Fallback: execCommand for Electron windows that block clipboard API
                    cfgEl.select()
                    doc.execCommand('copy')
                    flashStatus('Copied to clipboard.')
                })
        })

        btnSave?.addEventListener('click', () => {
            if (!cfgEl) { return }
            // Post back to parent window
            if (win.opener) {
                win.opener.postMessage({ type: 'config-save', config: cfgEl.value }, '*')
            }
            flashStatus('Saved to topology \u2713')
        })

        btnClose?.addEventListener('click', () => { win.close() })

        doc.addEventListener('keydown', (e: KeyboardEvent) => {
            if ((e.metaKey || e.ctrlKey) && e.key === 's') {
                e.preventDefault()
                btnSave?.click()
            }
        })

        // Listen for messages from the child window
        this._configMessageHandler = (e: MessageEvent) => {
            if (e.source !== win) { return }
            if (e.data?.type === 'config-save') {
                this.draft.startupConfig = e.data.config
                this.applyStartupConfig()
                this.cdr.markForCheck()
            }
        }
        window.addEventListener('message', this._configMessageHandler)

        // Clean up when child window closes
        const checkClosed = setInterval(() => {
            if (win.closed) {
                clearInterval(checkClosed)
                if (this._configMessageHandler) {
                    window.removeEventListener('message', this._configMessageHandler)
                    this._configMessageHandler = null
                }
                this._configWindow = null
            }
        }, 500)
    }

    private _buildConfigEditorHtml (label: string, config: string): string {
        const escaped = config
            .replace(/&/g, '&amp;')
            .replace(/</g, '&lt;')
            .replace(/>/g, '&gt;')
            .replace(/"/g, '&quot;')
        // NOTE: No inline onclick / <script> blocks — CSP 'self' blocks them.
        // All event listeners are attached programmatically by openConfigWindow().
        return `<!DOCTYPE html>
<html>
<head>
<style>
  * { margin: 0; padding: 0; box-sizing: border-box; }
  body {
    background: #0f1923; color: #c9d1d9; font-family: -apple-system, system-ui, sans-serif;
    display: flex; flex-direction: column; height: 100vh; overflow: hidden;
  }
  .header {
    display: flex; align-items: center; justify-content: space-between;
    padding: 10px 16px; border-bottom: 1px solid #1e2d42; background: #141e2d; flex-shrink: 0;
  }
  .title { font-size: 14px; font-weight: 600; }
  .actions { display: flex; gap: 8px; }
  .btn {
    border-radius: 6px; padding: 6px 16px; font-size: 12px; cursor: pointer;
    border: 1px solid #1e2d42; background: transparent; color: #6e8099;
    transition: background 0.12s, color 0.12s;
  }
  .btn:hover { background: #0a1120; color: #c9d1d9; }
  .btn-primary {
    background: rgba(59,130,246,0.12); border-color: rgba(59,130,246,0.4);
    color: #3b82f6; font-weight: 600;
  }
  .btn-primary:hover { background: rgba(59,130,246,0.22); }
  .btn-close { font-size: 16px; padding: 4px 10px; line-height: 1; }
  .btn-close:hover { color: #ef4444; border-color: #ef4444; }
  textarea {
    flex: 1; background: #060e18; border: none; color: #a8d8a8;
    font-size: 13px; font-family: 'Courier New', monospace;
    padding: 16px 20px; outline: none; resize: none; line-height: 1.6; width: 100%;
  }
  textarea::placeholder { color: #6e8099; opacity: 0.4; }
  .status { padding: 4px 16px; font-size: 10px; color: #6e8099; background: #141e2d;
    border-top: 1px solid #1e2d42; flex-shrink: 0; }
</style>
</head>
<body>
  <div class="header">
    <span class="title">Startup Config \u2014 ${label.replace(/</g, '&lt;')}</span>
    <div class="actions">
      <button class="btn" id="btn-copy">Copy</button>
      <button class="btn btn-primary" id="btn-save">Save to Topology</button>
      <button class="btn btn-close" id="btn-close" title="Close">\u2715</button>
    </div>
  </div>
  <textarea id="cfg" spellcheck="false" placeholder="! Paste startup config here...">${escaped}</textarea>
  <div class="status" id="status">Edit config and click "Save to Topology" to apply changes.</div>
</body>
</html>`
    }

    // ── Config push to device / container ────────────────────────────────────

    configPushing = false
    configPushOutput: string | null = null
    configPushConfirm = false

    /** Find the matching containerlab container for this node */
    private _findContainerForNode (): { name: string; state: string; kind: string } | undefined {
        if (!this.node || !this.clabDeployed || !this.clabContainers.length) { return undefined }
        const safeName = this.node.label
            .replace(/\s+/g, '-')
            .replace(/[^a-zA-Z0-9_.-]/g, '')
            .toLowerCase()
        return this.clabContainers.find(c => c.name.toLowerCase().endsWith('-' + safeName))
    }

    /** Whether this node can push config via SSH (physical device).
     *  Falls back to the device inventory when the Info-tab SSH fields are
     *  empty — so the button enables as long as we can resolve creds from
     *  *somewhere* (node fields OR inventory match). */
    get canPushSsh (): boolean {
        if (!this.node) { return false }
        const host = (this.node.mgmtIp ?? '').split('/')[0].trim()
        const vendor = (this.node.vendor ?? '').trim()
        if (!host || !vendor || !this.draft.startupConfig?.trim()) { return false }
        const creds = this._resolveCreds()
        return creds.source !== 'none'
    }

    /** Whether this node can push config to a running container */
    get canPushContainer (): boolean {
        if (!this.draft.startupConfig?.trim()) { return false }
        const ctn = this._findContainerForNode()
        return !!(ctn && ctn.state === 'running')
    }

    /** Descriptive button text */
    get pushTargetLabel (): string {
        const ctn = this._findContainerForNode()
        if (ctn && ctn.state === 'running') { return 'Push to Container' }
        if (this.canPushSsh) { return 'Push to Device (SSH)' }
        return 'Push to Device'
    }

    /** Validation result for the staged config — recomputed when the user
     *  hits Push so the inline confirmation panel can show issues. */
    pushValidation: ValidationResult | null = null

    confirmPushConfig (): void {
        // Lint the config first so the confirmation panel shows any issues
        // before the user clicks "Confirm Push".
        if (this.node?.vendor && this.draft.startupConfig) {
            this.pushValidation = validateConfig(this.node.vendor, this.draft.startupConfig)
            if (this.pushValidation.errors > 0 || this.pushValidation.warnings > 0) {
                console.warn(`[push] ${this.node.label} pre-push validation:`, this.pushValidation)
            }
        } else {
            this.pushValidation = null
        }
        this.configPushConfirm = true
        this.configPushOutput = null
        this.cdr.markForCheck()
    }

    cancelPushConfig (): void {
        this.configPushConfirm = false
        this.cdr.markForCheck()
    }

    async executePushConfig (): Promise<void> {
        if (!this.node || !this.nodeId) { return }
        const config = (this.draft.startupConfig ?? '').trim()
        if (!config) { return }

        // Auto-backup current running config before pushing
        if (this.canPushSsh && this.invSvc) {
            try { await this.invSvc.backupConfig(this.nodeId, 'running', 'event') }
            catch { /* backup failure should not block push */ }
        }

        this.configPushing = true
        this.configPushConfirm = false
        this.cdr.markForCheck()

        const api = (window as any).netopsAPI

        try {
            const ctn = this._findContainerForNode()
            if (ctn && ctn.state === 'running' && api?.clabPushConfig) {
                // ── Container push via docker exec ──
                const configLines = config.split('\n').map((l: string) => l.trimEnd()).filter((l: string) => l.length > 0)
                const result = await api.clabPushConfig({
                    containerName: ctn.name,
                    kind: ctn.kind,
                    configLines,
                })
                this.configPushOutput = result.ok
                    ? `✓ ${result.message}\n\n${result.output || ''}`
                    : `✗ ${result.message}\n\n${result.output || ''}`
            } else if (this.canPushSsh && api?.sshShellSession) {
                // ── SSH push to physical device ──
                const host = (this.node.mgmtIp ?? '').split('/')[0].trim()
                // Resolve creds: node Info-tab fields → device inventory fallback.
                await this._ensureInventoryLoaded()
                const creds = this._resolveCreds()
                if (creds.source === 'none') {
                    this.configPushOutput = '✗ No SSH credentials — set on Info tab or in Device Mapper inventory.'
                    this.configPushing = false
                    this.cdr.markForCheck()
                    return
                }
                const credSourceNote = creds.source === 'inventory'
                    ? ` (using credentials from inventory match: ${creds.matchedHostname ?? '?'})`
                    : ''
                const username = creds.username
                const password = creds.password
                const vendorKey = (this.node.vendor ?? '').trim().toLowerCase()
                const cmds = getVendorCommands(vendorKey)
                const preamble = cmds.loadConfigPreamble ?? ['configure terminal']
                const postamble = cmds.loadConfigPostamble ?? ['end', 'write memory']

                const configLines = config.split('\n')
                    .map((l: string) => l.trimEnd())
                    .filter((l: string) => l.length > 0)
                    .filter((l: string) => !/^Building configuration/i.test(l))
                    .filter((l: string) => !/^Current configuration\s*:/i.test(l))
                    .filter((l: string) => !/^Last configuration change/i.test(l))

                const commands = [...preamble, ...configLines, ...postamble]
                const backend = this._getBackendSvc()
                let result: any
                if (backend?.isConnected) {
                    result = await backend.loadConfig(host, this.node.sshPort ?? 22, username, password, commands, 300)
                } else {
                    result = await api.sshShellSession({
                        host,
                        port: this.node.sshPort ?? 22,
                        username,
                        password,
                        timeoutMs: 60000,
                        commands,
                        delayMs: 300,
                    })
                }
                this.configPushOutput = result.ok
                    ? `✓ Config pushed via SSH to ${host}${credSourceNote}\n\n${result.output || ''}`
                    : `✗ SSH push failed: ${result.message || result.output || 'Unknown error'}${credSourceNote}`
            } else {
                this.configPushOutput = '✗ Cannot push: no running container or SSH credentials available'
            }
        } catch (err) {
            this.configPushOutput = `✗ Error: ${(err as Error).message}`
        }

        this.configPushing = false
        this.cdr.markForCheck()
    }

    closePushOutput (): void {
        this.configPushOutput = null
        this.cdr.markForCheck()
    }

    // ── Config Diff (Running vs Startup) ────────────────────────────────────

    configDiffOutput: { line: string; type: 'add' | 'remove' | 'same' }[] | null = null
    configDiffFetching = false
    configDiffError: string | null = null

    /** Whether this node can fetch running config for diff */
    get canFetchDiff (): boolean {
        if (!this.draft.startupConfig?.trim()) { return false }
        const ctn = this._findContainerForNode()
        if (ctn && ctn.state === 'running') { return true }
        return this.canPushSsh
    }

    async fetchAndDiffConfig (): Promise<void> {
        if (!this.node || !this.nodeId) { return }
        const startupConfig = (this.draft.startupConfig ?? '').trim()
        if (!startupConfig) { return }

        this.configDiffFetching = true
        this.configDiffOutput = null
        this.configDiffError = null
        this.cdr.markForCheck()

        const api = (window as any).netopsAPI
        let runningConfig: string | null = null

        try {
            const ctn = this._findContainerForNode()
            if (ctn && ctn.state === 'running' && api?.clabFetchConfig) {
                // Try container fetch
                const result = await api.clabFetchConfig({ containerName: ctn.name, kind: ctn.kind })
                if (result.ok) {
                    runningConfig = result.output ?? ''
                } else {
                    this.configDiffError = result.message
                }
            } else if (this.canPushSsh && api?.sshRunCommand) {
                // Fallback to SSH
                const host = (this.node.mgmtIp ?? '').split('/')[0].trim()
                const username = (this.node.sshUsername ?? '').trim()
                const password = this.node.sshPassword ?? ''
                const vendorKey = (this.node.vendor ?? '').trim().toLowerCase()
                const cmds = getVendorCommands(vendorKey)

                const backend = this._getBackendSvc()
                let result: any
                if (backend?.isConnected) {
                    result = await backend.runCommand(host, this.node.sshPort ?? 22, username, password, cmds.showRunningConfig)
                } else {
                    result = await api.sshRunCommand({
                        host,
                        port: this.node.sshPort ?? 22,
                        username,
                        password,
                        timeoutMs: 30000,
                        command: cmds.showRunningConfig,
                    })
                }
                if (result.ok) {
                    runningConfig = result.output ?? ''
                } else {
                    this.configDiffError = result.message
                }
            } else {
                this.configDiffError = 'No running container or SSH credentials available'
            }
        } catch (err) {
            this.configDiffError = `Error: ${(err as Error).message}`
        }

        if (runningConfig != null) {
            // Simple line-by-line diff
            const startupLines = startupConfig.split('\n').map(l => l.trimEnd())
            const runningLines = runningConfig.split('\n').map(l => l.trimEnd())
            const startupSet = new Set(startupLines)
            const runningSet = new Set(runningLines)
            const diffResult: { line: string; type: 'add' | 'remove' | 'same' }[] = []

            // Lines in running but not in startup → additions (running has extra)
            for (const line of runningLines) {
                if (!line.trim()) { continue }
                if (startupSet.has(line)) {
                    diffResult.push({ line, type: 'same' })
                } else {
                    diffResult.push({ line, type: 'add' })
                }
            }
            // Lines in startup but not in running → removed from running
            for (const line of startupLines) {
                if (!line.trim()) { continue }
                if (!runningSet.has(line)) {
                    diffResult.push({ line, type: 'remove' })
                }
            }

            this.configDiffOutput = diffResult
        }

        this.configDiffFetching = false
        this.cdr.markForCheck()
    }

    closeDiffOutput (): void {
        this.configDiffOutput = null
        this.configDiffError = null
        this.cdr.markForCheck()
    }

    get configDiffAddCount (): number {
        return this.configDiffOutput?.filter(d => d.type === 'add').length ?? 0
    }

    get configDiffRemoveCount (): number {
        return this.configDiffOutput?.filter(d => d.type === 'remove').length ?? 0
    }

    /** Open the diff output in a full-size popup window */
    expandDiffWindow (): void {
        if (!this.configDiffOutput?.length || !this.node) { return }

        const escHtml = (s: string) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
        const addCount = this.configDiffAddCount
        const removeCount = this.configDiffRemoveCount
        const sameCount = this.configDiffOutput.filter(d => d.type === 'same').length

        const diffHtml = this.configDiffOutput.map(d => {
            if (d.type === 'add') { return `<div class="diff-added">+ ${escHtml(d.line)}</div>` }
            if (d.type === 'remove') { return `<div class="diff-removed">- ${escHtml(d.line)}</div>` }
            return `<div class="diff-common">  ${escHtml(d.line)}</div>`
        }).join('\n')

        const win = window.open('', '_blank', 'width=1200,height=800,menubar=no,toolbar=no')
        if (!win) { return }

        win.document.write(`<!DOCTYPE html><html><head><title>Config Diff: ${this.node.label}</title>
<style>
  body { margin: 0; font-family: 'SF Mono', 'Menlo', monospace; font-size: 12px; background: #1a1a2e; color: #e0e0e0; }
  .header { padding: 12px 20px; background: #16213e; border-bottom: 1px solid #333; display: flex; justify-content: space-between; align-items: center; }
  .header h2 { margin: 0; font-size: 16px; }
  .stats { display: flex; gap: 16px; font-size: 13px; }
  .stats .removed { color: #f87171; }
  .stats .added { color: #4ade80; }
  .stats .common { color: #94a3b8; }
  .diff { padding: 12px 20px; white-space: pre; overflow: auto; height: calc(100vh - 60px); }
  .diff-removed { color: #f87171; background: rgba(248,113,113,0.1); padding: 1px 4px; }
  .diff-added { color: #4ade80; background: rgba(74,222,128,0.1); padding: 1px 4px; }
  .diff-common { color: #64748b; padding: 1px 4px; }
</style></head><body>
<div class="header">
  <h2>Config Diff: ${this.node.label} (Running vs Startup)</h2>
  <div class="stats">
    <span class="removed">- ${removeCount} removed</span>
    <span class="added">+ ${addCount} added</span>
    <span class="common">= ${sameCount} matching</span>
  </div>
</div>
<div class="diff">${diffHtml}</div>
</body></html>`)
        win.document.close()
        win.document.title = `Config Diff: ${this.node.label}`
    }

    // ── Staging tab (per-node Day-0 overrides) ──────────────────────────────

    /** Fabric-wide defaults — displayed as placeholders so the user can see
     *  what they would inherit if they leave a field blank. */
    get fabricStaging (): any {
        return (this.svc.topology as any).staging ?? {}
    }
    get fabricNtpServersText (): string {
        return (this.fabricStaging.ntp?.servers ?? []).join(', ')
    }
    get fabricSyslogServersText (): string {
        return (this.fabricStaging.syslog?.servers ?? []).join(', ')
    }
    get fabricDnsServersText (): string {
        return (this.fabricStaging.dns?.servers ?? []).join(', ')
    }
    get fabricSnmpTrapTargetsText (): string {
        return (this.fabricStaging.snmp?.trapTargets ?? []).join(', ')
    }
    get fabricSnmpCommunity (): string { return this.fabricStaging.snmp?.community ?? '' }
    get fabricSnmpContact   (): string { return this.fabricStaging.snmp?.contact   ?? '' }
    get fabricSnmpLocation  (): string { return this.fabricStaging.snmp?.location  ?? '' }
    get fabricBannerLogin   (): string { return this.fabricStaging.banner?.login   ?? '' }

    /** Parse comma/newline-separated input to a clean string[]. */
    private _parseStagingList (s: string): string[] {
        return (s || '').split(/[,\n]+/).map(x => x.trim()).filter(Boolean)
    }

    /** Build a per-node staging override object from the buffer fields.
     *  Returns undefined if every override is empty (i.e. fully inherit). */
    private _buildStagingOverride (): any | undefined {
        const ntpServers    = this._parseStagingList(this.stagingNtpServersText)
        const sysServers    = this._parseStagingList(this.stagingSyslogServersText)
        const dnsServers    = this._parseStagingList(this.stagingDnsServersText)
        const trapTargets   = this._parseStagingList(this.stagingSnmpTrapTargetsText)
        const snmpComm      = (this.stagingSnmpCommunity || '').trim()
        const snmpContact   = (this.stagingSnmpContact   || '').trim()
        const snmpLocation  = (this.stagingSnmpLocation  || '').trim()
        const bannerLogin   = (this.stagingBannerLogin   || '').trim()

        const out: any = {}
        if (ntpServers.length)   out.ntp    = { servers: ntpServers }
        if (sysServers.length)   out.syslog = { servers: sysServers }
        if (dnsServers.length)   out.dns    = { servers: dnsServers }

        const snmp: any = {}
        if (snmpComm)            snmp.community   = snmpComm
        if (snmpContact)         snmp.contact     = snmpContact
        if (snmpLocation)        snmp.location    = snmpLocation
        if (trapTargets.length)  snmp.trapTargets = trapTargets
        if (Object.keys(snmp).length) out.snmp = snmp

        if (bannerLogin)         out.banner = { login: bannerLogin }

        return Object.keys(out).length ? out : undefined
    }

    applyStaging (): void {
        if (!this.nodeId) { return }
        const override = this._buildStagingOverride()
        // Cast — staging field is typed on TopologyNode but Partial may not pick it up cleanly.
        this.svc.updateNodeConfig(this.nodeId, { staging: override } as any)
        // Force regenerate so the merged staging block reaches the startup config.
        this.svc.regenerateConfigs(true)
        this.stagingMsg = override ? '✓ Per-node staging applied' : '✓ Cleared — node now inherits fabric staging'
        this.cdr.markForCheck()
        setTimeout(() => { this.stagingMsg = ''; this.cdr.markForCheck() }, 2500)
    }

    clearStagingOverride (): void {
        this.stagingNtpServersText = ''
        this.stagingSyslogServersText = ''
        this.stagingDnsServersText = ''
        this.stagingSnmpTrapTargetsText = ''
        this.stagingSnmpCommunity = ''
        this.stagingSnmpContact = ''
        this.stagingSnmpLocation = ''
        this.stagingBannerLogin = ''
        if (this.nodeId) {
            this.svc.updateNodeConfig(this.nodeId, { staging: undefined } as any)
            this.svc.regenerateConfigs(true)
        }
        this.stagingMsg = '✓ Cleared — node now inherits fabric staging'
        this.cdr.markForCheck()
        setTimeout(() => { this.stagingMsg = ''; this.cdr.markForCheck() }, 2500)
    }

    // ── Push Staging Only (Day-0 push, independent of fabric config) ──────────
    stagingPushing = false
    stagingPushOutput: string | null = null
    stagingPushPreview: string | null = null
    stagingCommitAfter = true

    /** Build the merged staging block (fabric defaults + per-node override). */
    private _buildMergedStaging (): any {
        const fabric  = (this.svc.topology as any).staging
        const perNode = this._buildStagingOverride()
        return mergeStaging(fabric, perNode)
    }

    /** Whether this node can push staging via SSH (physical) or container. */
    get canPushStaging (): boolean {
        if (!this.node || !this.node.vendor) { return false }
        if (!isSupportedStagingVendor(this.node.vendor)) { return false }
        const merged = this._buildMergedStaging()
        const block  = renderStagingConfig(this.node.vendor, merged)
        if (!block.trim()) { return false }
        return this.canPushSsh || this.canPushContainer
    }

    /** Human-readable reason the Push Staging button is disabled — surfaced
     *  in the UI as an inline hint so users know what to fix. Returns ''
     *  when the button is enabled. */
    get stagingDisabledReason (): string {
        if (!this.node) { return '' }
        if (!this.node.vendor) { return 'Set vendor on the Info tab first' }
        if (!isSupportedStagingVendor(this.node.vendor)) {
            return `Vendor '${this.node.vendor}' not yet supported by the staging builder`
        }
        const merged = this._buildMergedStaging()
        const block  = renderStagingConfig(this.node.vendor, merged)
        if (!block.trim()) { return 'No staging configured — set fabric defaults via Devices → Device Staging…, or add per-node overrides above' }
        if (!(this.canPushSsh || this.canPushContainer)) {
            return 'No SSH credentials and no running container — add Mgmt IP / username / password on the Info tab'
        }
        return ''
    }

    /** Show a non-destructive preview of the staging block that would be pushed. */
    previewPushStaging (): void {
        if (!this.node || !this.node.vendor) { return }
        const merged = this._buildMergedStaging()
        const block  = renderStagingConfig(this.node.vendor, merged)
        this.stagingPushPreview = block.trim()
            ? block
            : '(no staging configured — set fabric defaults via Devices → Device Staging…, or add per-node overrides above)'
        this.cdr.markForCheck()
    }

    closeStagingPreview (): void {
        this.stagingPushPreview = null
        this.cdr.markForCheck()
    }

    closeStagingPushOutput (): void {
        this.stagingPushOutput = null
        this.cdr.markForCheck()
    }

    /** Push only the merged Day-0 staging block to this device, independent
     *  of the full startup config. Auto-backs up running config first. */
    async executePushStaging (): Promise<void> {
        if (!this.node || !this.nodeId || !this.node.vendor) { return }

        // Defense-in-depth: refuse unsupported vendors with a clear message.
        if (!isSupportedStagingVendor(this.node.vendor)) {
            this.stagingPushOutput = `✗ Vendor '${this.node.vendor}' is not yet supported by the staging builder. `
                + `Supported: juniper, cisco, arista, hpe, dell, huawei, nokia, sonic, mikrotik, extreme.`
            this.cdr.markForCheck()
            return
        }

        const merged = this._buildMergedStaging()
        const cmds   = buildStagingPushCommands(this.node.vendor, merged, {
            commitAfter: this.stagingCommitAfter,
        })
        if (!cmds.length) {
            this.stagingPushOutput = '✗ Nothing to push — staging block is empty.'
            this.cdr.markForCheck()
            return
        }

        const confirmMsg = `Push Day-0 staging to "${this.node.label}"? `
            + `${cmds.length} command(s)${this.stagingCommitAfter ? ', will save to startup' : ', running config only'}.`
        if (!confirm(confirmMsg)) { return }

        // Auto-backup current running config first (best-effort).
        if (this.canPushSsh && this.invSvc) {
            try { await this.invSvc.backupConfig(this.nodeId, 'running', 'event') }
            catch { /* backup failure should not block push */ }
        }

        this.stagingPushing = true
        this.stagingPushOutput = null
        this.cdr.markForCheck()

        const api = (window as any).netopsAPI
        try {
            const ctn = this._findContainerForNode()
            if (ctn && ctn.state === 'running' && api?.clabPushConfig) {
                // Container path — feed each line to the container CLI.
                const result = await api.clabPushConfig({
                    containerName: ctn.name,
                    kind: ctn.kind,
                    configLines: cmds,
                })
                this.stagingPushOutput = result.ok
                    ? `✓ Staging pushed to container ${ctn.name}\n\n${result.output || ''}`
                    : `✗ Container push failed: ${result.message}\n\n${result.output || ''}`
            } else if (this.canPushSsh && api?.sshShellSession) {
                const host = (this.node.mgmtIp ?? '').split('/')[0].trim()
                // Make sure inventory is loaded before resolving — handles the
                // edge case where push is invoked before the lazy-load completes.
                await this._ensureInventoryLoaded()
                const creds = this._resolveCreds()
                if (creds.source === 'none') {
                    this.stagingPushOutput = '✗ No SSH credentials — set on Info tab or in Device Mapper inventory.'
                    this.stagingPushing = false
                    this.cdr.markForCheck()
                    return
                }
                const credSourceNote = creds.source === 'inventory'
                    ? ` (using credentials from inventory match: ${creds.matchedHostname ?? '?'})`
                    : ''
                const username = creds.username
                const password = creds.password

                // For Junos, buildStagingPushCommands returns the multi-line list;
                // wrap into a single `cli -c` invocation so the commit is atomic.
                let commands: string[]
                if (/^juniper/i.test(this.node.vendor)) {
                    const body = cmds
                        .filter(c => c !== 'configure private' && c !== 'commit and-quit')
                        .join('; ')
                    commands = [`cli -c "configure private; ${body}; commit and-quit"`]
                } else {
                    commands = cmds
                }

                const backend = this._getBackendSvc()
                let result: any
                if (backend?.isConnected) {
                    result = await backend.loadConfig(host, this.node.sshPort ?? 22, username, password, commands, 300)
                } else {
                    result = await api.sshShellSession({
                        host,
                        port: this.node.sshPort ?? 22,
                        username,
                        password,
                        timeoutMs: 60000,
                        commands,
                        delayMs: 300,
                    })
                }
                this.stagingPushOutput = result.ok
                    ? `✓ Staging pushed via SSH to ${host}${credSourceNote}\n\n${result.output || ''}`
                    : `✗ SSH push failed: ${result.message || result.output || 'Unknown error'}${credSourceNote}`
            } else {
                this.stagingPushOutput = '✗ Cannot push: no running container or SSH credentials available'
            }
        } catch (err) {
            this.stagingPushOutput = `✗ Error: ${(err as Error).message}`
        }

        this.stagingPushing = false
        this.cdr.markForCheck()
    }

    // ── Notes tab ───────────────────────────────────────────────────────────

    applyNotes (): void {
        if (!this.nodeId) { return }
        this.svc.updateNodeConfig(this.nodeId, { notes: this.draft.notes ?? '' })
    }

    // ── Status controls ─────────────────────────────────────────────────────

    startNode (): void {
        if (!this.nodeId) { return }
        this.svc.startNode(this.nodeId)
    }

    stopNode (): void {
        if (!this.nodeId) { return }
        this.svc.stopNode(this.nodeId)
    }

    suspendNode (): void {
        if (!this.nodeId) { return }
        this.svc.suspendNode(this.nodeId)
    }

    // ── Delete ──────────────────────────────────────────────────────────────

    deleteNode (): void {
        if (!this.nodeId) { return }
        if (!confirm(`Delete ${this.node?.label}? All connected links will also be removed.`)) { return }
        this.svc.removeNode(this.nodeId)
        this.closed.emit()
    }

    close (): void { this.closed.emit() }

    get typeMeta (): NodeTypeMeta | null {
        return this.node ? NODE_TYPE_META[this.node.type] : null
    }

    get connectedLinkCount (): number {
        return Object.keys(this.portLinkMap).length
    }

    // ── Inventory tab ─────────────────────────────────────────────────────────

    get invVersion () { return this.nodeId ? this.invSvc.getDeviceVersion(this.nodeId) : null }

    get invBackups () {
        if (!this.nodeId) { return [] }
        return this.invSvc.store.configBackups
            .filter(b => b.nodeId === this.nodeId)
            .sort((a, b) => b.timestamp.localeCompare(a.timestamp))
            .slice(0, 10)
    }

    get invAlarms () {
        if (!this.nodeId) { return [] }
        return this.invSvc.store.alarms
            .filter(a => a.nodeId === this.nodeId && !a.clearedAt)
    }

    get invUpgradePlans () {
        if (!this.nodeId) { return [] }
        return this.invSvc.store.upgradePlans
            .filter(u => u.nodeId === this.nodeId)
    }

    get invCanPoll (): boolean {
        if (!this.node) { return false }
        const host = (this.node.mgmtIp ?? '').split('/')[0].trim()
        return !!(host && (this.node.sshUsername ?? '').trim() && (this.node.sshPassword ?? '').trim())
    }

    invPolling = false
    invPollError = ''

    async invPollDevice (): Promise<void> {
        if (!this.nodeId || this.invPolling) { return }
        this.invPolling = true
        this.invPollError = ''
        this.cdr.markForCheck()
        try {
            await this.invSvc.pollDevice(this.nodeId)
            // Build sync proposal after polling
            this.pollSyncProposal = this.invSvc.buildSyncProposal(this.nodeId)
            if (this.pollSyncProposal) {
                this.proposalChecked = {}
                if (this.pollSyncProposal.modelChange) {
                    this.proposalChecked['model'] = true
                }
                for (const pc of this.pollSyncProposal.portChanges) {
                    this.proposalChecked[`port:${pc.portId}`] = true
                }
            }
            // Check if there was a poll error stored by the service
            const dv = this.invSvc.getDeviceVersion(this.nodeId)
            if (dv?.pollError) { this.invPollError = dv.pollError }
        } catch (err) {
            this.invPollError = (err as Error).message || 'Poll failed'
        } finally {
            this.invPolling = false
            this.cdr.markForCheck()
        }
    }

    async invBackupConfig (): Promise<void> {
        if (!this.nodeId) { return }
        this.invPolling = true
        this.cdr.markForCheck()
        try {
            await this.invSvc.backupConfig(this.nodeId, 'running', 'manual')
        } catch (err) {
            this.invPollError = (err as Error).message || 'Backup failed'
        } finally {
            this.invPolling = false
            this.cdr.markForCheck()
        }
    }

    // ── Config backup actions ──────────────────────────────────────────

    viewingBackup: ConfigBackupEntry | null = null
    diffingBackupA: ConfigBackupEntry | null = null
    diffingBackupB: ConfigBackupEntry | null = null
    backupDiffResult: string | null = null
    backupDiffMode = false

    viewBackup (entry: ConfigBackupEntry): void {
        if (this.viewingBackup?.id === entry.id) {
            this.viewingBackup = null
        } else {
            this.viewingBackup = entry
        }
        this.cdr.markForCheck()
    }

    exportBackup (entry: ConfigBackupEntry): void {
        this.invSvc.exportBackup(entry)
    }

    toggleDiffMode (): void {
        this.backupDiffMode = !this.backupDiffMode
        if (!this.backupDiffMode) {
            this.diffingBackupA = null
            this.diffingBackupB = null
            this.backupDiffResult = null
        }
        this.cdr.markForCheck()
    }

    selectDiffBackup (entry: ConfigBackupEntry): void {
        if (!this.diffingBackupA) {
            this.diffingBackupA = entry
        } else if (!this.diffingBackupB && entry.id !== this.diffingBackupA.id) {
            this.diffingBackupB = entry
            this.backupDiffResult = this.invSvc.diffConfigs(this.diffingBackupA, this.diffingBackupB)
        } else {
            // Reset selection
            this.diffingBackupA = entry
            this.diffingBackupB = null
            this.backupDiffResult = null
        }
        this.cdr.markForCheck()
    }

    isDiffSelected (entry: ConfigBackupEntry): boolean {
        return entry.id === this.diffingBackupA?.id || entry.id === this.diffingBackupB?.id
    }

    closeDiffViewer (): void {
        this.backupDiffMode = false
        this.diffingBackupA = null
        this.diffingBackupB = null
        this.backupDiffResult = null
        this.cdr.markForCheck()
    }

    // ── Config restore (load config to device) ───────────────────────

    loadConfigTarget: ConfigBackupEntry | null = null
    loadingConfig = false
    loadConfigOutput: string | null = null

    confirmLoadConfig (entry: ConfigBackupEntry): void {
        this.loadConfigTarget = entry
        this.loadConfigOutput = null
        this.cdr.markForCheck()
    }

    cancelLoadConfig (): void {
        this.loadConfigTarget = null
        this.cdr.markForCheck()
    }

    async executeLoadConfig (): Promise<void> {
        if (!this.loadConfigTarget || !this.nodeId) { return }
        this.loadingConfig = true
        this.cdr.markForCheck()
        try {
            const result = await this.invSvc.loadConfig(this.nodeId, this.loadConfigTarget.id)
            this.loadConfigOutput = result.output
        } catch (err) {
            this.loadConfigOutput = `Error: ${(err as Error).message}`
        }
        this.loadingConfig = false
        this.loadConfigTarget = null
        this.cdr.markForCheck()
    }

    closeLoadOutput (): void {
        this.loadConfigOutput = null
        this.cdr.markForCheck()
    }

    invRelativeTime (iso: string): string {
        const diff = Date.now() - new Date(iso).getTime()
        if (diff < 60000) { return 'just now' }
        if (diff < 3600000) { return `${Math.floor(diff / 60000)}m ago` }
        if (diff < 86400000) { return `${Math.floor(diff / 3600000)}h ago` }
        return `${Math.floor(diff / 86400000)}d ago`
    }

    // ── Poll Sync Proposal ──────────────────────────────────────────────

    pollSyncProposal: PollSyncProposal | null = null
    proposalChecked: Record<string, boolean> = {}

    get hasProposalChanges (): boolean {
        if (!this.pollSyncProposal) { return false }
        return !!(this.pollSyncProposal.modelChange || this.pollSyncProposal.portChanges.length > 0)
    }

    get checkedProposalCount (): number {
        return Object.values(this.proposalChecked).filter(Boolean).length
    }

    toggleProposalCheck (key: string): void {
        this.proposalChecked = { ...this.proposalChecked, [key]: !this.proposalChecked[key] }
        this.cdr.markForCheck()
    }

    toggleAllProposalChecks (checked: boolean): void {
        if (!this.pollSyncProposal) { return }
        const next = { ...this.proposalChecked }
        if (this.pollSyncProposal.modelChange) {
            next['model'] = checked
        }
        for (const pc of this.pollSyncProposal.portChanges) {
            next[`port:${pc.portId}`] = checked
        }
        this.proposalChecked = next
        this.cdr.markForCheck()
    }

    applySyncProposal (): void {
        if (!this.pollSyncProposal) { return }
        const accepted = new Set<string>(
            Object.entries(this.proposalChecked)
                .filter(([, v]) => v)
                .map(([k]) => k),
        )
        this.invSvc.applySyncProposal(this.pollSyncProposal, accepted)
        this.pollSyncProposal = null
        this.proposalChecked = {}
        this.cdr.markForCheck()
    }

    dismissSyncProposal (): void {
        this.pollSyncProposal = null
        this.proposalChecked = {}
        this.cdr.markForCheck()
    }

    // ── SNMP config methods ────────────────────────────────────────────────

    snmpTestBusy = false
    snmpTestMsg = ''
    snmpTestOk = false

    applyPollMethod (): void {
        if (!this.nodeId) { return }
        this.svc.updateNodeConfig(this.nodeId, { pollMethod: this.draft.pollMethod as any })
    }

    applySnmpVersion (): void {
        if (!this.nodeId) { return }
        this.svc.updateNodeConfig(this.nodeId, { snmpVersion: this.draft.snmpVersion as any })
    }

    applySnmpCommunity (): void {
        if (!this.nodeId) { return }
        this.svc.updateNodeConfig(this.nodeId, { snmpCommunity: (this.draft.snmpCommunity ?? '').trim() })
    }

    applySnmpPort (): void {
        if (!this.nodeId) { return }
        this.svc.updateNodeConfig(this.nodeId, { snmpPort: this.draft.snmpPort })
    }

    async testSnmpConnection (): Promise<void> {
        if (!this.node || this.snmpTestBusy) { return }
        const api = window.netopsAPI
        if (!api?.snmpTestConnection) { return }

        this.snmpTestBusy = true
        this.snmpTestMsg = 'Testing SNMP connection…'
        this.snmpTestOk = false
        this.cdr.markForCheck()

        const params: any = {
            version: this.draft.snmpVersion ?? '2c',
            host: (this.draft.mgmtIp ?? '').split('/')[0],
            port: this.draft.snmpPort ?? 161,
            timeoutMs: 5000,
        }
        if (params.version === '2c') {
            params.community = this.draft.snmpCommunity ?? 'public'
        } else {
            params.username = this.draft.snmpAuthPassword ?? ''
            if (this.draft.snmpAuthProtocol) { params.authProtocol = this.draft.snmpAuthProtocol }
            if (this.draft.snmpPrivProtocol) { params.privProtocol = this.draft.snmpPrivProtocol }
        }

        const result = await api.snmpTestConnection(params)
        this.snmpTestBusy = false
        this.snmpTestOk = result.ok
        this.snmpTestMsg = result.ok
            ? `✓ ${result.data?.[0]?.value?.slice(0, 80) ?? 'Connection OK'}`
            : `✗ ${result.message}`
        this.cdr.markForCheck()
    }

    // ── Config Snippet Library ───────────────────────────────────────────────

    toggleSnippetLibrary (): void {
        this.showSnippetLibrary = !this.showSnippetLibrary
        if (this.showSnippetLibrary && !this.snippets.length) {
            this.loadSnippets()
        }
        this.cdr.markForCheck()
    }

    async loadSnippets (): Promise<void> {
        const api = window.netopsAPI
        if (!api?.snippetLoadAll) { return }
        const result = await api.snippetLoadAll()
        if (result.ok) {
            this.snippets = result.snippets ?? []
        }
        this.cdr.markForCheck()
    }

    get filteredSnippets (): ConfigSnippet[] {
        let list = this.snippets
        if (this.snippetFilter !== 'all') {
            list = list.filter(s => s.category === this.snippetFilter)
        }
        const q = this.snippetSearch.trim().toLowerCase()
        if (q) {
            list = list.filter(s =>
                s.name.toLowerCase().includes(q) ||
                s.content.toLowerCase().includes(q) ||
                (s.vendor ?? '').toLowerCase().includes(q),
            )
        }
        return list
    }

    insertSnippet (snippet: ConfigSnippet): void {
        if (!this.node || !this.nodeId) { return }
        // Variable interpolation
        let content = snippet.content
        const vars: Record<string, string> = {
            hostname: this.node.label ?? '',
            loopback_ip: this.node.loopbackIp?.split('/')[0] ?? '',
            mgmt_ip: this.node.mgmtIp?.split('/')[0] ?? '',
            vendor: this.node.vendor ?? '',
            asn: String(this.node.asn ?? ''),
            role: this.node.role ?? '',
        }
        for (const [key, val] of Object.entries(vars)) {
            content = content.replace(new RegExp(`\\{\\{\\s*${key}\\s*\\}\\}`, 'gi'), val)
        }

        const current = this.draft.startupConfig ?? ''
        this.draft.startupConfig = current ? `${current}\n${content}` : content
        this.svc.updateNodeConfig(this.nodeId, { startupConfig: this.draft.startupConfig })
        this.showSnippetLibrary = false
        this.cdr.markForCheck()
    }

    async saveCurrentAsSnippet (): Promise<void> {
        if (!this.draft.startupConfig?.trim() || !this.savingSnippetName.trim()) { return }
        const api = window.netopsAPI
        if (!api?.snippetSave) { return }

        // Extract variables from content
        const varPattern = /\{\{\s*(\w+)\s*\}\}/g
        const variables: string[] = []
        let match: RegExpExecArray | null
        const content = this.draft.startupConfig
        while ((match = varPattern.exec(content)) !== null) {
            if (!variables.includes(match[1])) { variables.push(match[1]) }
        }

        const now = new Date().toISOString()
        const newSnippet: ConfigSnippet = {
            id: `snip-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
            name: this.savingSnippetName.trim(),
            vendor: this.node?.vendor,
            category: this.savingSnippetCategory,
            content,
            variables,
            createdAt: now,
            updatedAt: now,
        }

        const all = [...this.snippets, newSnippet]
        const result = await api.snippetSave(all)
        if (result.ok) {
            this.snippets = all
            this.savingSnippetName = ''
        }
        this.cdr.markForCheck()
    }

    async deleteSnippet (id: string): Promise<void> {
        const api = window.netopsAPI
        if (!api?.snippetDelete) { return }
        const result = await api.snippetDelete(id)
        if (result.ok) {
            this.snippets = this.snippets.filter(s => s.id !== id)
        }
        this.cdr.markForCheck()
    }
}
