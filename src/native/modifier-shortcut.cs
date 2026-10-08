using System;
using System.Runtime.InteropServices;
using System.Threading;
using System.Windows.Forms;
class ModifierShortcut {
    delegate IntPtr Callback(int code, IntPtr message, IntPtr data);
    static Callback callback = Handle;
    static IntPtr hook;
    static bool ctrl, shift, armed, cancelled;
    [DllImport("user32.dll")] static extern IntPtr SetWindowsHookEx(int type, Callback cb, IntPtr module, uint thread);
    [DllImport("user32.dll")] static extern IntPtr CallNextHookEx(IntPtr h, int code, IntPtr message, IntPtr data);
    [DllImport("user32.dll")] static extern bool UnhookWindowsHookEx(IntPtr h);
    [DllImport("kernel32.dll")] static extern IntPtr GetModuleHandle(string name);
    static IntPtr Handle(int code, IntPtr message, IntPtr data) {
        if (code >= 0) {
            int key = Marshal.ReadInt32(data), msg = message.ToInt32();
            bool down = msg == 0x100 || msg == 0x104;
            bool up = msg == 0x101 || msg == 0x105;
            bool control = key == 0x11 || key == 0xA2 || key == 0xA3;
            bool sh = key == 0x10 || key == 0xA0 || key == 0xA1;
            if (down || up) {
                if (control) ctrl = down;
                else if (sh) shift = down;
                else if (down) cancelled = true;
                if (ctrl && shift && !armed) armed = true;
                if (armed && (!ctrl || !shift)) {
                    if (!cancelled) { Console.WriteLine("say"); Console.Out.Flush(); }
                    armed = false; cancelled = true;
                }
                if (!ctrl && !shift) cancelled = false;
            }
        }
        return CallNextHookEx(hook, code, message, data);
    }
    static void Main() {
        hook = SetWindowsHookEx(13, callback, GetModuleHandle(null), 0);
        if (hook == IntPtr.Zero) Environment.Exit(1);
        Console.WriteLine("ready"); Console.Out.Flush();
        var input = new Thread(() => { while (Console.ReadLine() != null) {} Environment.Exit(0); });
        input.IsBackground = true; input.Start();
        Application.Run();
        UnhookWindowsHookEx(hook);
    }
}
