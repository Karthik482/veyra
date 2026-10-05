// Move the owning Electron window in physical pixels without ever resizing it.
// SWP_NOSIZE avoids the fractional-DPI size round trip in Electron SetBounds.
using System;
using System.Runtime.InteropServices;
using System.Reflection;
[assembly: AssemblyTitle("Veyra Window Movement")]
[assembly: AssemblyProduct("Veyra")]
[assembly: AssemblyVersion("0.3.1.0")]
class WindowMover {
    [StructLayout(LayoutKind.Sequential)] struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)] struct MonitorInfo { public int Size; public Rect Monitor, Work; public uint Flags; }
    [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr handle, out Rect rect);
    [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr handle, out uint processId);
    [DllImport("user32.dll")] static extern uint GetDpiForWindow(IntPtr handle);
    [DllImport("user32.dll")] static extern IntPtr MonitorFromWindow(IntPtr handle, uint flags);
    [DllImport("user32.dll")] static extern bool GetMonitorInfo(IntPtr monitor, ref MonitorInfo info);
    [DllImport("user32.dll")] static extern bool SetProcessDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll", SetLastError = true)] static extern bool SetWindowPos(IntPtr handle, IntPtr after, int x, int y, int width, int height, uint flags);
    static void Main(string[] args) {
        uint owner;
        if (args.Length != 1 || !uint.TryParse(args[0], out owner)) return;
        SetProcessDpiAwarenessContext(new IntPtr(-4));
        string line;
        while ((line = Console.ReadLine()) != null) {
            string id = "0";
            try {
                string[] parts = line.Split('|');
                if (parts.Length != 3) throw new Exception("invalid request");
                id = int.Parse(parts[0]).ToString();
                IntPtr handle = new IntPtr(long.Parse(parts[1]));
                uint processId; Rect rect;
                GetWindowThreadProcessId(handle, out processId);
                if (processId != owner || !GetWindowRect(handle, out rect)) throw new Exception("window unavailable");
                uint dpi = GetDpiForWindow(handle);
                int step = (int)Math.Round(24 * (dpi == 0 ? 96 : dpi) / 96.0);
                int dx = 0, dy = 0;
                switch (parts[2]) {
                    case "left": dx = -step; break; case "right": dx = step; break;
                    case "up": dy = -step; break; case "down": dy = step; break;
                    default: throw new Exception("invalid direction");
                }
                MonitorInfo monitor = new MonitorInfo(); monitor.Size = Marshal.SizeOf(monitor);
                if (!GetMonitorInfo(MonitorFromWindow(handle, 2), ref monitor)) throw new Exception("display unavailable");
                int width = rect.Right - rect.Left, height = rect.Bottom - rect.Top;
                int x = Math.Max(monitor.Work.Left, Math.Min(rect.Left + dx, monitor.Work.Right - width));
                int y = Math.Max(monitor.Work.Top, Math.Min(rect.Top + dy, monitor.Work.Bottom - height));
                // NOSIZE | NOZORDER | NOACTIVATE: preserves dimensions, stacking and focus.
                if (!SetWindowPos(handle, IntPtr.Zero, x, y, 0, 0, 0x0015)) throw new Exception("move failed");
                if (!GetWindowRect(handle, out rect) || rect.Right - rect.Left != width || rect.Bottom - rect.Top != height)
                    throw new Exception("window dimensions changed");
                Console.WriteLine(id + "|ok|" + width + "|" + height);
            } catch (Exception error) { Console.WriteLine(id + "|error|" + error.Message); }
        }
    }
}
