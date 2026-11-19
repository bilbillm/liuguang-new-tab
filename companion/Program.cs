using System.Buffers.Binary;
using System.Text.Json;
using Windows.Graphics.Imaging;
using Windows.Storage;
using Windows.Storage.Streams;

var catalog = new Catalog();
using var playback = new WallpaperPlayback();
using var input = Console.OpenStandardInput();
using var output = Console.OpenStandardOutput();
var prefix = new byte[4];
bool indexed = false;

while (await input.ReadAsync(prefix.AsMemory(0, 1)) != 0)
{
    await input.ReadExactlyAsync(prefix.AsMemory(1));
    int length = BinaryPrimitives.ReadInt32LittleEndian(prefix);
    if (length is < 1 or > 1_000_000) break;
    var message = new byte[length];
    await input.ReadExactlyAsync(message);
    int requestId = 0;
    object reply;
    try
    {
        using var doc = JsonDocument.Parse(message);
        JsonElement request = doc.RootElement;
        requestId = request.GetProperty("requestId").GetInt32();
        string? action = request.GetProperty("action").GetString();
        if (!indexed || action == "catalog") { catalog.Refresh(); indexed = true; }

        object? data = action switch
        {
            "catalog" => new { installed = catalog.Engine != null, liveSupported = WallpaperPlayback.IsSupported(), projects = catalog.Projects.Values.OrderBy(item => item.Title, StringComparer.CurrentCultureIgnoreCase).Select(item => item.Summary()).ToArray() },
            "thumbnail" => await ReadThumbnail(Find(request, catalog).Preview),
            "video-info" => VideoInfo(Find(request, catalog)),
            "video-read" => ReadVideo(Find(request, catalog), request.GetProperty("offset").GetInt64()),
            "start" => await playback.Start(catalog.Engine, Find(request, catalog)),
            "frame" => await playback.Frame(request.GetProperty("id").GetString()),
            "stop" => Stop(playback),
            _ => throw new InvalidOperationException("未知的本机伴侣请求。")
        };
        reply = new { requestId, data };
    }
    catch (Exception error)
    {
        reply = new { requestId, error = error is InvalidOperationException ? error.Message : "本机壁纸暂时不可用。" };
        Console.Error.WriteLine(error);
    }

    byte[] bytes = JsonSerializer.SerializeToUtf8Bytes(reply);
    if (bytes.Length > 950_000) bytes = JsonSerializer.SerializeToUtf8Bytes(new { requestId, error = "本机壁纸响应超过大小限制。" });
    BinaryPrimitives.WriteInt32LittleEndian(prefix, bytes.Length);
    await output.WriteAsync(prefix);
    await output.WriteAsync(bytes);
    await output.FlushAsync();
}

static Wallpaper Find(JsonElement request, Catalog catalog)
{
    string? id = request.GetProperty("id").GetString();
    return id != null && catalog.Projects.TryGetValue(id, out var project) ? project : throw new InvalidOperationException("找不到这个 Wallpaper Engine 项目，请刷新本机壁纸列表。");
}

static object? Stop(WallpaperPlayback playback) { playback.Dispose(); return null; }

static async Task<object?> ReadThumbnail(string? path)
{
    if (path == null || !File.Exists(path) || new FileInfo(path).Length > 16_000_000) return null;
    try
    {
        var file = await StorageFile.GetFileFromPathAsync(path);
        using var source = await file.OpenAsync(FileAccessMode.Read);
        var decoder = await BitmapDecoder.CreateAsync(source);
        uint width = Math.Min(decoder.PixelWidth, 320);
        uint height = Math.Max(1, (uint)((long)width * decoder.PixelHeight / decoder.PixelWidth));
        if (height > 300) { width = Math.Max(1, width * 300 / height); height = 300; }
        var transform = new BitmapTransform { ScaledWidth = width, ScaledHeight = height };
        using var bitmap = await decoder.GetSoftwareBitmapAsync(BitmapPixelFormat.Bgra8, BitmapAlphaMode.Ignore, transform, ExifOrientationMode.RespectExifOrientation, ColorManagementMode.ColorManageToSRgb);
        using var destination = new InMemoryRandomAccessStream();
        var encoder = await BitmapEncoder.CreateAsync(BitmapEncoder.JpegEncoderId, destination);
        encoder.SetSoftwareBitmap(bitmap);
        await encoder.FlushAsync();
        using var reader = new DataReader(destination.GetInputStreamAt(0));
        var content = new byte[await reader.LoadAsync((uint)destination.Size)];
        reader.ReadBytes(content);
        return new { mime = "image/jpeg", content = Convert.ToBase64String(content) };
    }
    catch { return null; }
}

static object VideoInfo(Wallpaper project)
{
    if (project.Kind != "video") throw new InvalidOperationException("这个项目不是视频壁纸。");
    var file = new FileInfo(project.Entry);
    string mime = file.Extension.ToLowerInvariant() switch { ".mp4" => "video/mp4", ".webm" => "video/webm", _ => throw new InvalidOperationException("请使用 MP4 或 WebM 视频壁纸。") };
    return new { size = file.Length, mime };
}

static object ReadVideo(Wallpaper project, long offset)
{
    if (project.Kind != "video" || offset < 0 || Path.GetExtension(project.Entry).ToLowerInvariant() is not (".mp4" or ".webm")) throw new InvalidOperationException("无法读取这个视频壁纸。");
    using var file = File.Open(project.Entry, FileMode.Open, FileAccess.Read, FileShare.Read);
    if (offset >= file.Length) return new { content = "" };
    file.Position = offset;
    var buffer = new byte[(int)Math.Min(256 * 1024, file.Length - offset)];
    file.ReadExactly(buffer);
    return new { content = Convert.ToBase64String(buffer) };
}
