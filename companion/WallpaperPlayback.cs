using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using Windows.Graphics.Capture;
using Windows.Graphics.DirectX;
using Windows.Graphics.DirectX.Direct3D11;
using Windows.Graphics.Imaging;
using Windows.Storage.Streams;
using WinRT;

sealed class WallpaperPlayback : IDisposable
{
    private string? title;
    private string? engine;
    private string? projectId;
    private nint window;
    private string? latest;
    private IDirect3DDevice? device;
    private Direct3D11CaptureFramePool? pool;
    private GraphicsCaptureSession? session;
    private bool started;

    public static bool IsSupported() => OperatingSystem.IsWindowsVersionAtLeast(10, 0, 22621) && GraphicsCaptureSession.IsSupported();

    public async Task<object> Start(string? executable, Wallpaper project)
    {
        if (executable is null) throw new InvalidOperationException("本机未安装 Wallpaper Engine。");
        if (project.Kind is not ("scene" or "web")) throw new InvalidOperationException("这个壁纸应直接作为视频播放。");
        if (!IsSupported()) throw new InvalidOperationException("当前 Windows 不支持实时壁纸捕获。");
        if (projectId == project.Id && session != null && IsWindow(window)) return new { ready = true };
        Dispose();
        engine = executable;
        title = $"Liuguang-Wallpaper-{Guid.NewGuid():N}";
        try
        {
            bool mustLaunch = !EngineRunning(executable);
            if (mustLaunch)
            {
                Launch(executable);
                await Task.Delay(2200);
            }
            string[] command = ["-control", "openWallpaper", "-file", project.Entry, "-playInWindow", title, "-width", "960", "-height", "540", "-borderless"];
            Launch(executable, command);
            started = true;
            for (int attempt = 0; attempt < 64; attempt++)
            {
                window = FindWallpaperWindow();
                if (window != 0) break;
                if (attempt == 23 && mustLaunch) Launch(executable, command);
                await Task.Delay(125);
            }
            if (window == 0) throw new InvalidOperationException("Wallpaper Engine 没有打开壁纸窗口，请确认客户端正常运行后重试。");
            AttachWindow(window);
            projectId = project.Id;
            return new { ready = true };
        }
        catch { Dispose(); throw; }
    }

    public async Task<object> Frame(string? id)
    {
        if (projectId != id || pool == null) throw new InvalidOperationException("实时壁纸已断开，请重新连接。");
        if (!IsWindow(window))
        {
            nint replacement = 0;
            for (int attempt = 0; attempt < 14 && replacement == 0; attempt++)
            {
                replacement = FindWallpaperWindow();
                if (replacement == 0) await Task.Delay(100);
            }
            if (replacement == 0) throw new InvalidOperationException("实时壁纸已断开，请重新连接。");
            AttachWindow(replacement);
        }
        using var frame = pool.TryGetNextFrame();
        if (frame == null) return new { content = (string?)null };
        using var bitmap = await SoftwareBitmap.CreateCopyFromSurfaceAsync(frame.Surface);
        using var memory = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, memory);
        encoder.SetSoftwareBitmap(bitmap);
        uint width = (uint)Math.Min(bitmap.PixelWidth, 960);
        encoder.BitmapTransform.ScaledWidth = width;
        encoder.BitmapTransform.ScaledHeight = (uint)Math.Max(1, (long)width * bitmap.PixelHeight / bitmap.PixelWidth);
        await encoder.FlushAsync();
        if (memory.Size > 600_000) throw new InvalidOperationException("壁纸画面过大，无法传输。");
        using var reader = new DataReader(memory.GetInputStreamAt(0));
        uint length = await reader.LoadAsync((uint)memory.Size);
        var bytes = new byte[length];
        reader.ReadBytes(bytes);
        string content = Convert.ToBase64String(bytes);
        if (content == latest) return new { content = (string?)null };
        latest = content;
        return new { content };
    }

    public void Dispose()
    {
        ReleaseCapture();
        latest = null;
        projectId = null;
        window = 0;
        if (started && engine != null && title != null)
        {
            try { Launch(engine, "-control", "closeWallpaper", "-location", title); }
            catch (System.ComponentModel.Win32Exception) { }
        }
        started = false;
    }

    private void AttachWindow(nint target)
    {
        ReleaseCapture();
        window = target;
        var item = GraphicsCaptureItem.TryCreateFromWindowId(new Windows.UI.WindowId { Value = (ulong)window });
        if (item == null) throw new InvalidOperationException("无法捕获这个 Wallpaper Engine 窗口。");
        device = CreateDevice();
        pool = Direct3D11CaptureFramePool.CreateFreeThreaded(device, DirectXPixelFormat.B8G8R8A8UIntNormalized, 2, item.Size);
        session = pool.CreateCaptureSession(item);
        session.IsCursorCaptureEnabled = false;
        session.StartCapture();
    }

    private void ReleaseCapture()
    {
        session?.Dispose();
        pool?.Dispose();
        device?.Dispose();
        session = null;
        pool = null;
        device = null;
    }

    private nint FindWallpaperWindow()
    {
        nint match = 0;
        EnumWindows((candidate, _) =>
        {
            var caption = new StringBuilder(260);
            GetWindowText(candidate, caption, caption.Capacity);
            if (title is null || !caption.ToString().Contains(title, StringComparison.Ordinal)) return true;
            GetWindowThreadProcessId(candidate, out uint pid);
            try
            {
                using var owner = Process.GetProcessById((int)pid);
                string? path = owner.MainModule?.FileName;
                if (path == null || !path.StartsWith(Path.GetDirectoryName(engine)! + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase)) return true;
                match = candidate;
                return false;
            }
            catch (Exception error) when (error is ArgumentException or InvalidOperationException or System.ComponentModel.Win32Exception) { return true; }
        }, 0);
        return match;
    }

    private static void Launch(string executable, params string[] arguments)
    {
        var info = new ProcessStartInfo(executable) { WorkingDirectory = Path.GetDirectoryName(executable), UseShellExecute = false, CreateNoWindow = true };
        foreach (string argument in arguments) info.ArgumentList.Add(argument);
        using var process = Process.Start(info);
    }

    private static bool EngineRunning(string executable)
    {
        bool found = false;
        foreach (string name in new[] { "wallpaper32", "wallpaper64" })
        foreach (var process in Process.GetProcessesByName(name))
        {
            using (process)
            {
                try { found |= string.Equals(process.MainModule?.FileName, executable, StringComparison.OrdinalIgnoreCase); }
                catch (Exception error) when (error is InvalidOperationException or System.ComponentModel.Win32Exception) { }
            }
        }
        return found;
    }

    private static IDirect3DDevice CreateDevice()
    {
        const uint bgraSupport = 0x20;
        nint device = 0, dxgi = 0, inspectable = 0;
        try
        {
            int result = D3D11CreateDevice(0, 1, 0, bgraSupport, 0, 0, 7, out device, 0, 0);
            if (result < 0) result = D3D11CreateDevice(0, 5, 0, bgraSupport, 0, 0, 7, out device, 0, 0);
            Marshal.ThrowExceptionForHR(result);
            var dxgiGuid = new Guid("54EC77FA-1377-44E6-8C32-88FD5F44C84C");
            Marshal.ThrowExceptionForHR(Marshal.QueryInterface(device, in dxgiGuid, out dxgi));
            Marshal.ThrowExceptionForHR(CreateDirect3D11DeviceFromDXGIDevice(dxgi, out inspectable));
            return MarshalInterface<IDirect3DDevice>.FromAbi(inspectable)!;
        }
        finally
        {
            if (inspectable != 0) Marshal.Release(inspectable);
            if (dxgi != 0) Marshal.Release(dxgi);
            if (device != 0) Marshal.Release(device);
        }
    }

    private delegate bool WindowCallback(nint window, nint parameter);
    [DllImport("user32.dll")] private static extern bool EnumWindows(WindowCallback callback, nint parameter);
    [DllImport("user32.dll", CharSet = CharSet.Unicode)] private static extern int GetWindowText(nint window, StringBuilder text, int limit);
    [DllImport("user32.dll")] private static extern uint GetWindowThreadProcessId(nint window, out uint process);
    [DllImport("user32.dll")] private static extern bool IsWindow(nint window);
    [DllImport("d3d11.dll")] private static extern int D3D11CreateDevice(nint adapter, int driver, nint software, uint flags, nint levels, uint levelCount, uint sdkVersion, out nint device, nint chosenLevel, nint context);
    [DllImport("d3d11.dll")] private static extern int CreateDirect3D11DeviceFromDXGIDevice(nint device, out nint inspectable);
}
