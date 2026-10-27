// NOVA TV OS — Windows native probes.
// Compiled at runtime by nova-helper.ps1 via Add-Type (C# 5, .NET Framework 4.x),
// so it must avoid newer C# syntax. Read-only probes except the explicitly
// named setters (volume, DDC/CI VCP), which NOVA only calls on user request.

using System;
using System.Collections.Generic;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32;

namespace Nova
{
    public class ModeInfo
    {
        public int Width { get; set; }
        public int Height { get; set; }
        public int RefreshHz { get; set; }
        public int BitsPerPixel { get; set; }
        public bool Interlaced { get; set; }
    }

    public class DisplayPath
    {
        public string GdiName { get; set; }
        public string AdapterName { get; set; }
        public string FriendlyName { get; set; }
        public string MonitorDevicePath { get; set; }
        public string OutputTechnology { get; set; }
        public long OutputTechnologyCode { get; set; }
        public int X { get; set; }
        public int Y { get; set; }
        public int Width { get; set; }
        public int Height { get; set; }
        public double RefreshHz { get; set; }
        public bool AdvancedColorQueried { get; set; }
        public bool AdvancedColorSupported { get; set; }
        public bool AdvancedColorEnabled { get; set; }
        public bool WideColorEnforced { get; set; }
        public bool AdvancedColorForceDisabled { get; set; }
        public int BitsPerColorChannel { get; set; }
        public int ColorEncoding { get; set; }
        public string EdidBase64 { get; set; }
        public string EdidRegistryKey { get; set; }
        public ModeInfo Current { get; set; }
        public List<ModeInfo> Modes { get; set; }
        public List<string> Errors { get; set; }
    }

    public class DdcResult
    {
        public string GdiName { get; set; }
        public string Description { get; set; }
        public bool Supported { get; set; }
        public int Brightness { get; set; }
        public int BrightnessMax { get; set; }
        public int Contrast { get; set; }
        public int ContrastMax { get; set; }
        public string Error { get; set; }
    }

    public class GpuUsage
    {
        public double ThreeD { get; set; }
        public double VideoDecode { get; set; }
        public bool Available { get; set; }
        public string Error { get; set; }
    }

    public static class Displays
    {
        const uint QDC_ONLY_ACTIVE_PATHS = 0x00000002;
        const uint DEVICE_INFO_GET_SOURCE_NAME = 1;
        const uint DEVICE_INFO_GET_TARGET_NAME = 2;
        const uint DEVICE_INFO_GET_ADVANCED_COLOR_INFO = 9;
        const uint MODE_INFO_TYPE_SOURCE = 1;
        const int ENUM_CURRENT_SETTINGS = -1;
        const uint DM_INTERLACED = 0x00000002;

        [StructLayout(LayoutKind.Sequential)]
        public struct LUID { public uint LowPart; public int HighPart; }

        [StructLayout(LayoutKind.Sequential)]
        public struct RATIONAL { public uint Numerator; public uint Denominator; }

        [StructLayout(LayoutKind.Sequential)]
        public struct PATH_SOURCE_INFO { public LUID adapterId; public uint id; public uint modeInfoIdx; public uint statusFlags; }

        [StructLayout(LayoutKind.Sequential)]
        public struct PATH_TARGET_INFO
        {
            public LUID adapterId;
            public uint id;
            public uint modeInfoIdx;
            public uint outputTechnology;
            public uint rotation;
            public uint scaling;
            public RATIONAL refreshRate;
            public uint scanLineOrdering;
            public int targetAvailable;
            public uint statusFlags;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct PATH_INFO { public PATH_SOURCE_INFO sourceInfo; public PATH_TARGET_INFO targetInfo; public uint flags; }

        [StructLayout(LayoutKind.Sequential)]
        public struct REGION2D { public uint cx; public uint cy; }

        [StructLayout(LayoutKind.Sequential)]
        public struct VIDEO_SIGNAL_INFO
        {
            public ulong pixelRate;
            public RATIONAL hSyncFreq;
            public RATIONAL vSyncFreq;
            public REGION2D activeSize;
            public REGION2D totalSize;
            public uint videoStandard;
            public uint scanLineOrdering;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct POINTL { public int x; public int y; }

        [StructLayout(LayoutKind.Sequential)]
        public struct SOURCE_MODE { public uint width; public uint height; public uint pixelFormat; public POINTL position; }

        [StructLayout(LayoutKind.Explicit)]
        public struct MODE_UNION
        {
            [FieldOffset(0)] public VIDEO_SIGNAL_INFO targetVideoSignalInfo;
            [FieldOffset(0)] public SOURCE_MODE sourceMode;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct MODE_INFO { public uint infoType; public uint id; public LUID adapterId; public MODE_UNION modeInfo; }

        [StructLayout(LayoutKind.Sequential)]
        public struct DEVICE_INFO_HEADER { public uint type; public uint size; public LUID adapterId; public uint id; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct TARGET_DEVICE_NAME
        {
            public DEVICE_INFO_HEADER header;
            public uint flags;
            public uint outputTechnology;
            public ushort edidManufactureId;
            public ushort edidProductCodeId;
            public uint connectorInstance;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 64)] public string monitorFriendlyDeviceName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string monitorDevicePath;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct SOURCE_DEVICE_NAME
        {
            public DEVICE_INFO_HEADER header;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string viewGdiDeviceName;
        }

        [StructLayout(LayoutKind.Sequential)]
        public struct ADVANCED_COLOR_INFO
        {
            public DEVICE_INFO_HEADER header;
            public uint value;
            public uint colorEncoding;
            public uint bitsPerColorChannel;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct DEVMODE
        {
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmDeviceName;
            public ushort dmSpecVersion;
            public ushort dmDriverVersion;
            public ushort dmSize;
            public ushort dmDriverExtra;
            public uint dmFields;
            public int dmPositionX;
            public int dmPositionY;
            public uint dmDisplayOrientation;
            public uint dmDisplayFixedOutput;
            public short dmColor;
            public short dmDuplex;
            public short dmYResolution;
            public short dmTTOption;
            public short dmCollate;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string dmFormName;
            public ushort dmLogPixels;
            public uint dmBitsPerPel;
            public uint dmPelsWidth;
            public uint dmPelsHeight;
            public uint dmDisplayFlags;
            public uint dmDisplayFrequency;
            public uint dmICMMethod;
            public uint dmICMIntent;
            public uint dmMediaType;
            public uint dmDitherType;
            public uint dmReserved1;
            public uint dmReserved2;
            public uint dmPanningWidth;
            public uint dmPanningHeight;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct DISPLAY_DEVICE
        {
            public int cb;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string DeviceName;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceString;
            public uint StateFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceID;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string DeviceKey;
        }

        [DllImport("user32.dll")]
        static extern int GetDisplayConfigBufferSizes(uint flags, out uint numPathArrayElements, out uint numModeInfoArrayElements);

        [DllImport("user32.dll")]
        static extern int QueryDisplayConfig(uint flags, ref uint numPathArrayElements, [Out] PATH_INFO[] pathArray, ref uint numModeInfoArrayElements, [Out] MODE_INFO[] modeInfoArray, IntPtr currentTopologyId);

        [DllImport("user32.dll")]
        static extern int DisplayConfigGetDeviceInfo(ref TARGET_DEVICE_NAME requestPacket);

        [DllImport("user32.dll")]
        static extern int DisplayConfigGetDeviceInfo(ref SOURCE_DEVICE_NAME requestPacket);

        [DllImport("user32.dll")]
        static extern int DisplayConfigGetDeviceInfo(ref ADVANCED_COLOR_INFO requestPacket);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern bool EnumDisplaySettingsEx(string lpszDeviceName, int iModeNum, ref DEVMODE lpDevMode, uint dwFlags);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern bool EnumDisplayDevices(string lpDevice, uint iDevNum, ref DISPLAY_DEVICE lpDisplayDevice, uint dwFlags);

        public static string TechnologyName(long code)
        {
            switch (code)
            {
                case 0: return "vga";
                case 1: return "svideo";
                case 2: return "composite";
                case 3: return "component";
                case 4: return "dvi";
                case 5: return "hdmi";
                case 6: return "internal"; // LVDS
                case 8: return "d-jpn";
                case 9: return "sdi";
                case 10: return "displayport";
                case 11: return "internal"; // embedded DisplayPort
                case 12: return "udi";
                case 13: return "internal"; // embedded UDI
                case 14: return "sdtv-dongle";
                case 15: return "wireless"; // Miracast
                case 16: return "indirect-wired";
                case 17: return "virtual";
                case 18: return "usb-c"; // DisplayPort tunnelled over USB4
                case 0x80000000L: return "internal";
                default: return "unknown";
            }
        }

        static string AdapterNameFor(string gdiName)
        {
            DISPLAY_DEVICE dd = new DISPLAY_DEVICE();
            dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
            for (uint i = 0; EnumDisplayDevices(null, i, ref dd, 0); i++)
            {
                if (string.Equals(dd.DeviceName, gdiName, StringComparison.OrdinalIgnoreCase)) return dd.DeviceString;
                dd = new DISPLAY_DEVICE();
                dd.cb = Marshal.SizeOf(typeof(DISPLAY_DEVICE));
            }
            return null;
        }

        static List<ModeInfo> EnumModes(string gdiName, out ModeInfo current)
        {
            List<ModeInfo> modes = new List<ModeInfo>();
            HashSet<string> seen = new HashSet<string>();
            current = null;
            DEVMODE dm = new DEVMODE();
            dm.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
            if (EnumDisplaySettingsEx(gdiName, ENUM_CURRENT_SETTINGS, ref dm, 0))
            {
                current = new ModeInfo();
                current.Width = (int)dm.dmPelsWidth;
                current.Height = (int)dm.dmPelsHeight;
                current.RefreshHz = (int)dm.dmDisplayFrequency;
                current.BitsPerPixel = (int)dm.dmBitsPerPel;
                current.Interlaced = (dm.dmDisplayFlags & DM_INTERLACED) != 0;
            }
            for (int i = 0; i < 4096; i++)
            {
                dm = new DEVMODE();
                dm.dmSize = (ushort)Marshal.SizeOf(typeof(DEVMODE));
                if (!EnumDisplaySettingsEx(gdiName, i, ref dm, 0)) break;
                if (dm.dmBitsPerPel < 24) continue;
                bool interlaced = (dm.dmDisplayFlags & DM_INTERLACED) != 0;
                string key = dm.dmPelsWidth + "x" + dm.dmPelsHeight + "@" + dm.dmDisplayFrequency + (interlaced ? "i" : "");
                if (seen.Contains(key)) continue;
                seen.Add(key);
                ModeInfo m = new ModeInfo();
                m.Width = (int)dm.dmPelsWidth;
                m.Height = (int)dm.dmPelsHeight;
                m.RefreshHz = (int)dm.dmDisplayFrequency;
                m.BitsPerPixel = (int)dm.dmBitsPerPel;
                m.Interlaced = interlaced;
                modes.Add(m);
            }
            return modes;
        }

        static string ReadEdid(string monitorDevicePath, out string keyPath)
        {
            keyPath = null;
            if (string.IsNullOrEmpty(monitorDevicePath)) return null;
            // \\?\DISPLAY#GSM5B08#5&2a3a7a3d&0&UID4352#{e6f07b5f-...}
            string[] parts = monitorDevicePath.Split('#');
            if (parts.Length < 3) return null;
            keyPath = "SYSTEM\\CurrentControlSet\\Enum\\DISPLAY\\" + parts[1] + "\\" + parts[2] + "\\Device Parameters";
            using (RegistryKey k = Registry.LocalMachine.OpenSubKey(keyPath, false))
            {
                if (k == null) return null;
                byte[] edid = k.GetValue("EDID") as byte[];
                if (edid == null || edid.Length < 128) return null;
                return Convert.ToBase64String(edid);
            }
        }

        public static List<DisplayPath> Query()
        {
            List<DisplayPath> result = new List<DisplayPath>();
            uint numPaths, numModes;
            int err = GetDisplayConfigBufferSizes(QDC_ONLY_ACTIVE_PATHS, out numPaths, out numModes);
            if (err != 0) throw new Exception("GetDisplayConfigBufferSizes failed: " + err);
            PATH_INFO[] paths = new PATH_INFO[numPaths];
            MODE_INFO[] modes = new MODE_INFO[numModes];
            err = QueryDisplayConfig(QDC_ONLY_ACTIVE_PATHS, ref numPaths, paths, ref numModes, modes, IntPtr.Zero);
            if (err != 0) throw new Exception("QueryDisplayConfig failed: " + err);

            for (int p = 0; p < numPaths; p++)
            {
                PATH_INFO path = paths[p];
                DisplayPath d = new DisplayPath();
                d.Errors = new List<string>();
                d.OutputTechnologyCode = path.targetInfo.outputTechnology;
                d.OutputTechnology = TechnologyName((long)path.targetInfo.outputTechnology);
                if (path.targetInfo.refreshRate.Denominator != 0)
                    d.RefreshHz = Math.Round((double)path.targetInfo.refreshRate.Numerator / path.targetInfo.refreshRate.Denominator, 3);

                TARGET_DEVICE_NAME target = new TARGET_DEVICE_NAME();
                target.header.type = DEVICE_INFO_GET_TARGET_NAME;
                target.header.size = (uint)Marshal.SizeOf(typeof(TARGET_DEVICE_NAME));
                target.header.adapterId = path.targetInfo.adapterId;
                target.header.id = path.targetInfo.id;
                if (DisplayConfigGetDeviceInfo(ref target) == 0)
                {
                    d.FriendlyName = target.monitorFriendlyDeviceName;
                    d.MonitorDevicePath = target.monitorDevicePath;
                }
                else d.Errors.Add("target name unavailable");

                SOURCE_DEVICE_NAME source = new SOURCE_DEVICE_NAME();
                source.header.type = DEVICE_INFO_GET_SOURCE_NAME;
                source.header.size = (uint)Marshal.SizeOf(typeof(SOURCE_DEVICE_NAME));
                source.header.adapterId = path.sourceInfo.adapterId;
                source.header.id = path.sourceInfo.id;
                if (DisplayConfigGetDeviceInfo(ref source) == 0) d.GdiName = source.viewGdiDeviceName;
                else d.Errors.Add("source name unavailable");

                ADVANCED_COLOR_INFO color = new ADVANCED_COLOR_INFO();
                color.header.type = DEVICE_INFO_GET_ADVANCED_COLOR_INFO;
                color.header.size = (uint)Marshal.SizeOf(typeof(ADVANCED_COLOR_INFO));
                color.header.adapterId = path.targetInfo.adapterId;
                color.header.id = path.targetInfo.id;
                if (DisplayConfigGetDeviceInfo(ref color) == 0)
                {
                    d.AdvancedColorQueried = true;
                    d.AdvancedColorSupported = (color.value & 0x1) != 0;
                    d.AdvancedColorEnabled = (color.value & 0x2) != 0;
                    d.WideColorEnforced = (color.value & 0x4) != 0;
                    d.AdvancedColorForceDisabled = (color.value & 0x8) != 0;
                    d.BitsPerColorChannel = (int)color.bitsPerColorChannel;
                    d.ColorEncoding = (int)color.colorEncoding;
                }
                else d.Errors.Add("advanced colour info unavailable (requires Windows 10 1709+)");

                uint srcIdx = path.sourceInfo.modeInfoIdx;
                if (srcIdx < numModes && modes[srcIdx].infoType == MODE_INFO_TYPE_SOURCE)
                {
                    SOURCE_MODE sm = modes[srcIdx].modeInfo.sourceMode;
                    d.X = sm.position.x;
                    d.Y = sm.position.y;
                    d.Width = (int)sm.width;
                    d.Height = (int)sm.height;
                }

                if (!string.IsNullOrEmpty(d.GdiName))
                {
                    ModeInfo current;
                    try
                    {
                        d.Modes = EnumModes(d.GdiName, out current);
                        d.Current = current;
                    }
                    catch (Exception e) { d.Errors.Add("mode enumeration failed: " + e.Message); }
                    try { d.AdapterName = AdapterNameFor(d.GdiName); }
                    catch (Exception e) { d.Errors.Add("adapter name failed: " + e.Message); }
                }

                try
                {
                    string key;
                    d.EdidBase64 = ReadEdid(d.MonitorDevicePath, out key);
                    d.EdidRegistryKey = key;
                    if (d.EdidBase64 == null) d.Errors.Add("EDID not found in registry");
                }
                catch (Exception e) { d.Errors.Add("EDID read failed: " + e.Message); }

                result.Add(d);
            }
            return result;
        }
    }

    public static class Ddc
    {
        [StructLayout(LayoutKind.Sequential)]
        public struct RECT { public int left; public int top; public int right; public int bottom; }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct MONITORINFOEX
        {
            public int cbSize;
            public RECT rcMonitor;
            public RECT rcWork;
            public uint dwFlags;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 32)] public string szDevice;
        }

        [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
        public struct PHYSICAL_MONITOR
        {
            public IntPtr hPhysicalMonitor;
            [MarshalAs(UnmanagedType.ByValTStr, SizeConst = 128)] public string szPhysicalMonitorDescription;
        }

        delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdcMonitor, ref RECT lprcMonitor, IntPtr dwData);

        [DllImport("user32.dll")]
        static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);

        [DllImport("user32.dll", CharSet = CharSet.Unicode)]
        static extern bool GetMonitorInfo(IntPtr hMonitor, ref MONITORINFOEX lpmi);

        [DllImport("dxva2.dll", SetLastError = true)]
        static extern bool GetNumberOfPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, out uint count);

        [DllImport("dxva2.dll", SetLastError = true)]
        static extern bool GetPhysicalMonitorsFromHMONITOR(IntPtr hMonitor, uint size, [Out] PHYSICAL_MONITOR[] monitors);

        [DllImport("dxva2.dll", SetLastError = true)]
        static extern bool DestroyPhysicalMonitors(uint size, PHYSICAL_MONITOR[] monitors);

        [DllImport("dxva2.dll", SetLastError = true)]
        static extern bool GetVCPFeatureAndVCPFeatureReply(IntPtr hMonitor, byte code, out int type, out uint current, out uint maximum);

        [DllImport("dxva2.dll", SetLastError = true)]
        static extern bool SetVCPFeature(IntPtr hMonitor, byte code, uint value);

        static IntPtr FindMonitor(string gdiName)
        {
            IntPtr found = IntPtr.Zero;
            MonitorEnumProc proc = delegate (IntPtr h, IntPtr dc, ref RECT r, IntPtr data)
            {
                MONITORINFOEX mi = new MONITORINFOEX();
                mi.cbSize = Marshal.SizeOf(typeof(MONITORINFOEX));
                if (GetMonitorInfo(h, ref mi) && string.Equals(mi.szDevice, gdiName, StringComparison.OrdinalIgnoreCase))
                {
                    found = h;
                    return false;
                }
                return true;
            };
            EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, proc, IntPtr.Zero);
            GC.KeepAlive(proc);
            return found;
        }

        public static DdcResult Probe(string gdiName)
        {
            DdcResult r = new DdcResult();
            r.GdiName = gdiName;
            IntPtr hmon = FindMonitor(gdiName);
            if (hmon == IntPtr.Zero) { r.Error = "monitor not found"; return r; }
            uint count;
            if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, out count) || count == 0) { r.Error = "no physical monitor handle"; return r; }
            PHYSICAL_MONITOR[] mons = new PHYSICAL_MONITOR[count];
            if (!GetPhysicalMonitorsFromHMONITOR(hmon, count, mons)) { r.Error = "GetPhysicalMonitorsFromHMONITOR failed"; return r; }
            try
            {
                r.Description = mons[0].szPhysicalMonitorDescription;
                int type; uint cur, max;
                if (GetVCPFeatureAndVCPFeatureReply(mons[0].hPhysicalMonitor, 0x10, out type, out cur, out max))
                {
                    r.Supported = true;
                    r.Brightness = (int)cur;
                    r.BrightnessMax = (int)max;
                }
                else r.Error = "display did not answer DDC/CI brightness query (error " + Marshal.GetLastWin32Error() + ")";
                if (r.Supported && GetVCPFeatureAndVCPFeatureReply(mons[0].hPhysicalMonitor, 0x12, out type, out cur, out max))
                {
                    r.Contrast = (int)cur;
                    r.ContrastMax = (int)max;
                }
            }
            finally { DestroyPhysicalMonitors(count, mons); }
            return r;
        }

        /// Sets a VCP value and reads it back. Only brightness (0x10) and contrast (0x12) are allowed.
        public static DdcResult Set(string gdiName, byte code, uint value)
        {
            if (code != 0x10 && code != 0x12) throw new ArgumentException("VCP code not allowed");
            IntPtr hmon = FindMonitor(gdiName);
            if (hmon == IntPtr.Zero) throw new Exception("monitor not found");
            uint count;
            if (!GetNumberOfPhysicalMonitorsFromHMONITOR(hmon, out count) || count == 0) throw new Exception("no physical monitor handle");
            PHYSICAL_MONITOR[] mons = new PHYSICAL_MONITOR[count];
            if (!GetPhysicalMonitorsFromHMONITOR(hmon, count, mons)) throw new Exception("GetPhysicalMonitorsFromHMONITOR failed");
            try
            {
                if (!SetVCPFeature(mons[0].hPhysicalMonitor, code, value)) throw new Exception("SetVCPFeature failed (" + Marshal.GetLastWin32Error() + ")");
            }
            finally { DestroyPhysicalMonitors(count, mons); }
            System.Threading.Thread.Sleep(120);
            return Probe(gdiName);
        }
    }

    // ---- Core Audio (default render endpoint master volume) ----

    [ComImport, Guid("5CDF2C82-841E-4546-9722-0CF74078229A"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IAudioEndpointVolume
    {
        int RegisterControlChangeNotify(IntPtr pNotify);
        int UnregisterControlChangeNotify(IntPtr pNotify);
        int GetChannelCount(out uint pnChannelCount);
        int SetMasterVolumeLevel(float fLevelDB, ref Guid pguidEventContext);
        int SetMasterVolumeLevelScalar(float fLevel, ref Guid pguidEventContext);
        int GetMasterVolumeLevel(out float pfLevelDB);
        int GetMasterVolumeLevelScalar(out float pfLevel);
        int SetChannelVolumeLevel(uint nChannel, float fLevelDB, ref Guid pguidEventContext);
        int SetChannelVolumeLevelScalar(uint nChannel, float fLevel, ref Guid pguidEventContext);
        int GetChannelVolumeLevel(uint nChannel, out float pfLevelDB);
        int GetChannelVolumeLevelScalar(uint nChannel, out float pfLevel);
        int SetMute([MarshalAs(UnmanagedType.Bool)] bool bMute, ref Guid pguidEventContext);
        int GetMute([MarshalAs(UnmanagedType.Bool)] out bool pbMute);
    }

    [ComImport, Guid("D666063F-1587-4E43-81F1-B948E807363F"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDevice
    {
        int Activate(ref Guid iid, int dwClsCtx, IntPtr pActivationParams, [MarshalAs(UnmanagedType.IUnknown)] out object ppInterface);
    }

    [ComImport, Guid("A95664D2-9614-4F35-A746-DE8DB63617E6"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IMMDeviceEnumerator
    {
        int EnumAudioEndpoints(int dataFlow, int dwStateMask, out IntPtr ppDevices);
        int GetDefaultAudioEndpoint(int dataFlow, int role, out IMMDevice ppEndpoint);
    }

    [ComImport, Guid("BCDE0395-E52F-467C-8E3D-C4579291692E")]
    class MMDeviceEnumeratorComObject { }

    public class VolumeState
    {
        public int Level { get; set; }
        public bool Muted { get; set; }
    }

    public static class Audio
    {
        static IAudioEndpointVolume Endpoint()
        {
            IMMDeviceEnumerator enumerator = (IMMDeviceEnumerator)(new MMDeviceEnumeratorComObject());
            IMMDevice device;
            Marshal.ThrowExceptionForHR(enumerator.GetDefaultAudioEndpoint(0 /* eRender */, 1 /* eMultimedia */, out device));
            Guid iid = typeof(IAudioEndpointVolume).GUID;
            object o;
            Marshal.ThrowExceptionForHR(device.Activate(ref iid, 23 /* CLSCTX_ALL */, IntPtr.Zero, out o));
            return (IAudioEndpointVolume)o;
        }

        public static VolumeState Get()
        {
            IAudioEndpointVolume v = Endpoint();
            float level; bool muted;
            Marshal.ThrowExceptionForHR(v.GetMasterVolumeLevelScalar(out level));
            Marshal.ThrowExceptionForHR(v.GetMute(out muted));
            VolumeState s = new VolumeState();
            s.Level = (int)Math.Round(level * 100);
            s.Muted = muted;
            return s;
        }

        public static VolumeState Set(int level)
        {
            if (level < 0) level = 0;
            if (level > 100) level = 100;
            Guid ctx = Guid.Empty;
            Marshal.ThrowExceptionForHR(Endpoint().SetMasterVolumeLevelScalar(level / 100f, ref ctx));
            return Get();
        }

        public static VolumeState SetMute(bool mute)
        {
            Guid ctx = Guid.Empty;
            Marshal.ThrowExceptionForHR(Endpoint().SetMute(mute, ref ctx));
            return Get();
        }
    }

    // ---- GPU utilisation via PDH with locale-independent English counter names ----

    public static class Gpu
    {
        const uint PDH_FMT_DOUBLE = 0x00000200;
        const uint PDH_MORE_DATA = 0x800007D2;

        [StructLayout(LayoutKind.Sequential)]
        struct PDH_FMT_COUNTERVALUE { public uint CStatus; public double doubleValue; }

        [StructLayout(LayoutKind.Sequential)]
        struct PDH_FMT_COUNTERVALUE_ITEM { public IntPtr szName; public PDH_FMT_COUNTERVALUE FmtValue; }

        [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
        static extern uint PdhOpenQuery(string dataSource, IntPtr userData, out IntPtr query);

        [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
        static extern uint PdhAddEnglishCounter(IntPtr query, string path, IntPtr userData, out IntPtr counter);

        [DllImport("pdh.dll")]
        static extern uint PdhCollectQueryData(IntPtr query);

        [DllImport("pdh.dll", CharSet = CharSet.Unicode)]
        static extern uint PdhGetFormattedCounterArray(IntPtr counter, uint format, ref uint bufferSize, out uint itemCount, IntPtr buffer);

        static IntPtr query = IntPtr.Zero;
        static IntPtr counter3d = IntPtr.Zero;
        static IntPtr counterDecode = IntPtr.Zero;

        static double Sum(IntPtr counter)
        {
            uint size = 0, count;
            uint status = PdhGetFormattedCounterArray(counter, PDH_FMT_DOUBLE, ref size, out count, IntPtr.Zero);
            if (status != PDH_MORE_DATA || size == 0) return 0;
            IntPtr buf = Marshal.AllocHGlobal((int)size);
            try
            {
                status = PdhGetFormattedCounterArray(counter, PDH_FMT_DOUBLE, ref size, out count, buf);
                if (status != 0) return 0;
                int itemSize = Marshal.SizeOf(typeof(PDH_FMT_COUNTERVALUE_ITEM));
                double total = 0;
                for (int i = 0; i < count; i++)
                {
                    PDH_FMT_COUNTERVALUE_ITEM item = (PDH_FMT_COUNTERVALUE_ITEM)Marshal.PtrToStructure(new IntPtr(buf.ToInt64() + i * itemSize), typeof(PDH_FMT_COUNTERVALUE_ITEM));
                    if (item.FmtValue.CStatus == 0) total += item.FmtValue.doubleValue;
                }
                return Math.Min(100.0, Math.Round(total, 1));
            }
            finally { Marshal.FreeHGlobal(buf); }
        }

        public static GpuUsage Sample()
        {
            GpuUsage u = new GpuUsage();
            try
            {
                if (query == IntPtr.Zero)
                {
                    if (PdhOpenQuery(null, IntPtr.Zero, out query) != 0) throw new Exception("PdhOpenQuery failed");
                    if (PdhAddEnglishCounter(query, "\\GPU Engine(*engtype_3D)\\Utilization Percentage", IntPtr.Zero, out counter3d) != 0)
                        throw new Exception("GPU Engine counters unavailable (requires Windows 10 1709+ and a WDDM 2.x driver)");
                    PdhAddEnglishCounter(query, "\\GPU Engine(*engtype_VideoDecode)\\Utilization Percentage", IntPtr.Zero, out counterDecode);
                    PdhCollectQueryData(query);
                    System.Threading.Thread.Sleep(300);
                }
                PdhCollectQueryData(query);
                u.ThreeD = Sum(counter3d);
                u.VideoDecode = counterDecode == IntPtr.Zero ? 0 : Sum(counterDecode);
                u.Available = true;
            }
            catch (Exception e) { u.Error = e.Message; }
            return u;
        }
    }
}
