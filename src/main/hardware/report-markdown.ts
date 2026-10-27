import type { Capability, HardwareReport } from '../../shared/types';

// Renders a HardwareReport as a readable Markdown document.

const badge = (c: Capability<unknown>) =>
  c.verification === 'verified' ? '✅ verified' : c.verification === 'reported' ? 'ℹ️ reported' : c.verification === 'unavailable' ? '❌ unavailable' : '❔ unknown';

export function reportToMarkdown(r: HardwareReport): string {
  const L: string[] = [];
  L.push('# NOVA TV OS — Hardware Capability Report', '');
  L.push(`Generated: ${r.generatedAt} · NOVA ${r.appVersion}`, '');
  L.push(
    '> Legend: **verified** = exercised by NOVA on this machine; **reported** = stated by the OS, driver or the display\'s EDID but not exercised; **unknown** = could not be determined.',
    '',
  );
  L.push('## System', '');
  L.push(`| Item | Value |`, `|---|---|`);
  L.push(`| Operating system | ${r.environment.osDescription} (${r.environment.platform} ${r.environment.osRelease}, ${r.environment.arch}) |`);
  L.push(`| Virtual machine | ${r.environment.isVirtualMachine.value ? 'yes' : 'no'} (${badge(r.environment.isVirtualMachine)}: ${r.environment.isVirtualMachine.source}) |`);
  L.push(`| CPU | ${r.cpu.model} — ${r.cpu.logicalCores} logical cores @ ${r.cpu.speedMHz} MHz |`);
  L.push(`| Memory | ${r.memory.totalMB} MB total, ${r.memory.freeMB} MB free at report time |`);
  L.push(`| Runtime | Electron ${r.environment.electron}, Chromium ${r.environment.chrome}, Node ${r.environment.node} |`);
  L.push('');

  L.push('## GPUs', '');
  if (!r.gpus.length) L.push('_No GPU reported._');
  for (const g of r.gpus) {
    L.push(`- **${g.name}** (${g.vendor})${g.active ? ' — active' : ''}; driver ${g.driverVersion ?? 'n/a'}${g.memoryMB ? `; ${g.memoryMB} MB reported` : ''} _(source: ${g.source})_`);
  }
  L.push('', `Chromium video decode acceleration: \`${r.chromiumGpu.videoDecodeAcceleration}\``, '');

  L.push('## Displays', '');
  L.push(`External display detected: **${r.externalDisplayDetected ? 'yes' : 'no'}**`, '');
  if (!r.displays.length) L.push('_No displays reported._');
  for (const d of r.displays) {
    L.push(`### ${d.label}${d.primary ? ' (primary)' : ''}`, '');
    L.push('| Property | Value | Trust |', '|---|---|---|');
    L.push(`| Connection | ${d.connection.value} | ${badge(d.connection)} — ${d.connection.source} |`);
    L.push(`| Current mode | ${d.currentMode.width}x${d.currentMode.height} @ ${d.currentMode.refreshHz} Hz | reported by OS |`);
    L.push(
      `| Native resolution | ${d.nativeResolution.value ? `${d.nativeResolution.value.width}x${d.nativeResolution.value.height}` : 'unknown'} | ${badge(d.nativeResolution)} — ${d.nativeResolution.source} |`,
    );
    if (d.edid?.maxMode) L.push(`| Highest advertised mode | ${d.edid.maxMode.width}x${d.edid.maxMode.height} @ ${Math.round(d.edid.maxMode.refreshHz)} Hz | ℹ️ reported — EDID |`);
    L.push(`| Scale factor | ${d.scaleFactor} | reported by OS |`);
    L.push(`| Colour depth / space | ${d.colorDepth}-bit, ${d.colorSpace || 'n/a'} | reported by Chromium |`);
    L.push(`| Display supports HDR | ${d.hdr.displaySupportsHdr.value ? 'yes' : 'no'} | ${badge(d.hdr.displaySupportsHdr)} — ${d.hdr.displaySupportsHdr.source} |`);
    L.push(`| OS HDR enabled | ${d.hdr.osHdrEnabled.value ? 'yes' : 'no'} | ${badge(d.hdr.osHdrEnabled)} — ${d.hdr.osHdrEnabled.source} |`);
    L.push(`| HDR formats (EDID) | ${d.hdr.supportedEotfs.join(', ') || 'none reported'} | ℹ️ reported |`);
    L.push(`| DDC/CI | ${d.ddcci.value ? 'yes' : 'no'} | ${badge(d.ddcci)} — ${d.ddcci.source}${d.ddcci.note ? ` (${d.ddcci.note})` : ''} |`);
    if (d.edid?.valid) {
      const e = d.edid;
      L.push(`| EDID identity | ${e.manufacturerId} ${e.monitorName ?? ''} product 0x${e.productCode.toString(16)} (${e.manufactureYear ?? 'year n/a'}), EDID ${e.edidVersion}${e.checksumOk ? '' : ' — checksum error'} | ℹ️ reported |`);
      if (e.physicalSizeCm) L.push(`| Physical size | ${e.physicalSizeCm.width} x ${e.physicalSizeCm.height} cm | ℹ️ reported — EDID |`);
      if (e.cea) {
        L.push(`| HDMI | ${e.cea.hdmiVsdb ? 'HDMI VSDB' : 'no HDMI VSDB'}${e.cea.hdmiForumVsdb ? ' + HDMI Forum (2.x)' : ''}${e.cea.hdmiMaxTmdsMHz ? `, max TMDS ${e.cea.hdmiMaxTmdsMHz} MHz` : ''} | ℹ️ reported — EDID |`);
        L.push(`| Colour formats | YCbCr 4:4:4 ${e.cea.ycbcr444 ? 'yes' : 'no'}, 4:2:2 ${e.cea.ycbcr422 ? 'yes' : 'no'}${e.cea.deepColor ? `, deep colour 30/36-bit ${e.cea.deepColor.dc30 ? 'yes' : 'no'}/${e.cea.deepColor.dc36 ? 'yes' : 'no'}` : ''} | ℹ️ reported — EDID |`);
        if (e.cea.colorimetry) L.push(`| Wide gamut | BT.2020 ${e.cea.colorimetry.bt2020rgb || e.cea.colorimetry.bt2020ycc ? 'yes' : 'no'}, DCI-P3 ${e.cea.colorimetry.dciP3 ? 'yes' : 'no'} | ℹ️ reported — EDID |`);
        L.push(`| Audio formats | ${e.cea.audioFormats.join(', ') || 'none'} | ℹ️ reported — EDID |`);
      }
    } else L.push('| EDID | not available | ❔ |');
    L.push('');
    if (d.availableModes.length) {
      const refreshByRes = new Map<string, number[]>();
      for (const m of d.availableModes) {
        const k = `${m.width}x${m.height}`;
        refreshByRes.set(k, [...(refreshByRes.get(k) ?? []), m.refreshHz]);
      }
      L.push('Available modes (reported by OS):', '');
      for (const [res, rates] of refreshByRes) L.push(`- ${res}: ${[...new Set(rates.map((x) => Math.round(x * 100) / 100))].join(', ')} Hz`);
      L.push('');
    }
    for (const n of d.notes) L.push(`> ${n}`);
    if (d.notes.length) L.push('');
  }

  L.push('## Video decoding', '');
  L.push(`Hardware decoding APIs compiled into mpv: ${r.decoding.hwdecMethodsCompiledIntoMpv.join(', ') || 'n/a'}`, '');
  if (r.decoding.tests.length) {
    L.push('| Format | Result | Decoder | Trust |', '|---|---|---|---|');
    for (const t of r.decoding.tests) {
      L.push(`| ${t.label} | ${t.hardware ? 'hardware' : t.verification === 'verified' ? 'software (CPU)' : 'unknown'} | ${t.method ?? '—'} | ${t.verification}${t.note ? ` — ${t.note}` : ''} |`);
    }
  } else L.push('_Decode tests were not run._');
  L.push('');

  L.push('## Audio output devices (via mpv)', '');
  if (!r.audioDevices.length) L.push('_None listed._');
  for (const a of r.audioDevices) L.push(`- \`${a.name}\` — ${a.description}`);
  L.push('');

  L.push('## Integrations / tools', '');
  L.push('| Tool | Found | Version | Path |', '|---|---|---|---|');
  for (const t of r.tools) L.push(`| ${t.name} | ${t.found ? 'yes' : 'no'} | ${t.version ?? '—'} | ${t.path ? `\`${t.path}\`` : '—'} |`);
  L.push('');

  L.push('## Network (private IPv4, used for the phone remote)', '');
  if (!r.network.length) L.push('_No private IPv4 address — the phone remote cannot be reached._');
  for (const n of r.network) L.push(`- ${n.interface}: ${n.address}`);
  L.push('');

  L.push('## Limitations and unsupported features', '');
  if (!r.limitations.length) L.push('_None detected._');
  for (const l of r.limitations) L.push(`- ${l}`);
  L.push('');

  L.push('## Probe log', '', '```');
  L.push(...r.probeLog);
  L.push('```', '');
  return L.join('\n');
}
