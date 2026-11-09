# Crea il collegamento "SingITnow" (con il logo) sul desktop e nel menu Start.
# Avvia l'app senza console, come SingITnow.bat.
#
# Il collegamento porta lo stesso "ID applicazione" (AppUserModelID) che la finestra di SingITnow
# dichiara all'avvio: così Windows riconosce che sono la stessa app e, aggiungendola alla barra
# delle applicazioni, tiene il logo e il comando di SingITnow anche quando l'app è chiusa
# (invece dell'icona generica di Python).
$ErrorActionPreference = "Stop"
$root = $PSScriptRoot
$pythonw = Join-Path $root ".venv\Scripts\pythonw.exe"
$icon = Join-Path $root "singitnow\icon.ico"
$appId = "SingITnow.App"   # deve essere uguale a quello in singitnow/__main__.py

Add-Type -TypeDefinition @"
using System;
using System.Runtime.InteropServices;

public static class ShortcutAppId {
    [ComImport, Guid("886D8EEB-8CF2-4446-8D02-CDBA1DBDCF99"), InterfaceType(ComInterfaceType.InterfaceIsIUnknown)]
    interface IPropertyStore {
        void GetCount(out uint count);
        void GetAt(uint index, out PropertyKey key);
        void GetValue(ref PropertyKey key, out PropVariant value);
        void SetValue(ref PropertyKey key, ref PropVariant value);
        void Commit();
    }
    [StructLayout(LayoutKind.Sequential, Pack = 4)]
    struct PropertyKey { public Guid fmtid; public uint pid; }
    [StructLayout(LayoutKind.Explicit)]
    struct PropVariant {
        [FieldOffset(0)] public ushort vt;
        [FieldOffset(8)] public IntPtr ptr;
    }
    [DllImport("shell32.dll", CharSet = CharSet.Unicode, PreserveSig = false)]
    static extern void SHGetPropertyStoreFromParsingName(string path, IntPtr bindCtx, int flags, ref Guid riid,
        [MarshalAs(UnmanagedType.Interface)] out IPropertyStore store);
    [DllImport("ole32.dll")] static extern int PropVariantClear(ref PropVariant pv);

    public static void Set(string lnkPath, string appId) {
        Guid iid = typeof(IPropertyStore).GUID;
        IPropertyStore store;
        SHGetPropertyStoreFromParsingName(lnkPath, IntPtr.Zero, 2 /* GPS_READWRITE */, ref iid, out store);
        // PKEY_AppUserModel_ID = {9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3}, 5
        PropertyKey key = new PropertyKey { fmtid = new Guid("9F4C2855-9F79-4B39-A8D0-E1D42DE1D5F3"), pid = 5 };
        PropVariant value = new PropVariant { vt = 31 /* VT_LPWSTR */, ptr = Marshal.StringToCoTaskMemUni(appId) };
        store.SetValue(ref key, ref value);
        store.Commit();
        PropVariantClear(ref value);
        Marshal.ReleaseComObject(store);
    }
}
"@

$shell = New-Object -ComObject WScript.Shell
$places = @(
    [Environment]::GetFolderPath("Desktop"),
    [Environment]::GetFolderPath("Programs")
)
foreach ($dir in $places) {
    $path = Join-Path $dir "SingITnow.lnk"
    $lnk = $shell.CreateShortcut($path)
    $lnk.TargetPath = $pythonw
    $lnk.Arguments = "-m singitnow"
    $lnk.WorkingDirectory = $root
    $lnk.IconLocation = "$icon,0"
    $lnk.Description = "SingITnow - karaoke tra amici"
    $lnk.Save()
    [ShortcutAppId]::Set($path, $appId)
    Write-Host "Collegamento creato: $path"
}
