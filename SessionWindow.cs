using System.Collections.Concurrent;
using System.Diagnostics;
using System.Runtime.InteropServices;

namespace Orbi;

// "Abrir terminal" (como no coucou): o curl do hook é neto do Claude Code, que roda num shell, que roda no
// terminal ou editor cuja janela queremos. Quando o curl conecta ele ainda está vivo: pela porta da conexão
// achamos o processo dele e subimos pelos pais até um que tenha janela. Fica guardado por sessão, só na memória.
// Console clássico (conhost) não é ancestral: aí não acha nada e o botão avisa.
public static class SessionWindow
{
    static readonly ConcurrentDictionary<string, int> Owners = new();
    static readonly string[] TreeTops = { "explorer", "services", "wininit", "winlogon", "svchost", "smss", "csrss", "sihost", "userinit" };

    /// <summary>Chamado quando um hook conecta: guarda o processo da janela da sessão (uma vez por sessão).</summary>
    public static void Remember(string sessionId, int clientPort, int serverPort)
    {
        if (Owners.TryGetValue(sessionId, out int known) && Alive(known)) return;
        try
        {
            if (ClientPid(clientPort, serverPort) is not { } pid) return;
            for (int depth = 0; depth < 16 && Parent(pid) is { } parent and > 4; depth++, pid = parent)
            {
                using var p = Process.GetProcessById(parent);
                if (TreeTops.Contains(p.ProcessName, StringComparer.OrdinalIgnoreCase)) return;
                if (p.MainWindowHandle != IntPtr.Zero) { Owners[sessionId] = parent; return; }
            }
        }
        catch { } // processo já saiu ou sem acesso: fica sem "Abrir terminal" para esta sessão
    }

    public static void Forget(string sessionId) => Owners.TryRemove(sessionId, out _);

    /// <summary>Traz a janela da sessão para frente. false se não sabemos qual é ou ela fechou.</summary>
    public static bool Focus(string? sessionId)
    {
        if (sessionId == null || !Owners.TryGetValue(sessionId, out int pid)) return false;
        try
        {
            using var p = Process.GetProcessById(pid);
            var h = p.MainWindowHandle;
            if (h == IntPtr.Zero) return false;
            if (IsIconic(h)) ShowWindow(h, 9); // SW_RESTORE
            // O Windows só deixa trocar a janela da frente logo depois de uma tecla: um Alt solto destrava.
            keybd_event(0x12, 0, 0, UIntPtr.Zero);
            keybd_event(0x12, 0, 2, UIntPtr.Zero);
            return SetForegroundWindow(h);
        }
        catch { return false; }
    }

    static bool Alive(int pid)
    {
        try { using var p = Process.GetProcessById(pid); return !p.HasExited; } catch { return false; }
    }

    // Tabela de conexões TCP com o dono de cada uma: a ponta do curl tem a porta local = porta remota que vimos.
    static int? ClientPid(int clientPort, int serverPort)
    {
        int size = 0;
        GetExtendedTcpTable(IntPtr.Zero, ref size, false, 2, 4, 0); // AF_INET, TCP_TABLE_OWNER_PID_CONNECTIONS
        var buf = Marshal.AllocHGlobal(size);
        try
        {
            if (GetExtendedTcpTable(buf, ref size, false, 2, 4, 0) != 0) return null;
            int count = Marshal.ReadInt32(buf);
            for (int i = 0; i < count; i++)
            {
                var row = buf + 4 + i * 24; // MIB_TCPROW_OWNER_PID: state, localAddr, localPort, remoteAddr, remotePort, pid
                int local = Port(Marshal.ReadInt32(row + 8)), remote = Port(Marshal.ReadInt32(row + 16));
                if (local == clientPort && remote == serverPort) return Marshal.ReadInt32(row + 20);
            }
            return null;
        }
        finally { Marshal.FreeHGlobal(buf); }
    }

    static int Port(int raw) => ((raw & 0xFF) << 8) | ((raw >> 8) & 0xFF); // ordem de rede nos 16 bits de baixo

    static int? Parent(int pid)
    {
        var h = OpenProcess(0x1000, false, pid); // PROCESS_QUERY_LIMITED_INFORMATION
        if (h == IntPtr.Zero) return null;
        try
        {
            var info = new long[6]; // PROCESS_BASIC_INFORMATION (64 bits): o pai é o 6º campo
            return NtQueryInformationProcess(h, 0, info, 48, out _) == 0 ? (int)info[5] : null;
        }
        finally { CloseHandle(h); }
    }

    [DllImport("iphlpapi.dll")] static extern uint GetExtendedTcpTable(IntPtr table, ref int size, bool order, int af, int tableClass, uint reserved);
    [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access, bool inherit, int pid);
    [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr h);
    [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr h, int infoClass, long[] info, int size, out int returned);
    [DllImport("user32.dll")] static extern bool SetForegroundWindow(IntPtr h);
    [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr h, int cmd);
    [DllImport("user32.dll")] static extern bool IsIconic(IntPtr h);
    [DllImport("user32.dll")] static extern void keybd_event(byte vk, byte scan, uint flags, UIntPtr extra);
}
