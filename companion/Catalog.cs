using System.Diagnostics;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using Microsoft.Win32;

sealed record Wallpaper(string Id, string Title, string Kind, string Source, string Entry, string? Preview)
{
    public object Summary() => new { id = Id, title = Title, kind = Kind, source = Source, thumb = Preview != null };
}

sealed class Catalog
{
    public string? Engine { get; private set; }
    public Dictionary<string, Wallpaper> Projects { get; } = new();

    public void Refresh()
    {
        Projects.Clear();
        var steamRoots = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        AddPath(steamRoots, Registry.GetValue(@"HKEY_CURRENT_USER\Software\Valve\Steam", "SteamPath", null) as string);
        AddPath(steamRoots, Registry.GetValue(@"HKEY_LOCAL_MACHINE\SOFTWARE\WOW6432Node\Valve\Steam", "InstallPath", null) as string);
        AddPath(steamRoots, Path.Combine(Environment.GetFolderPath(Environment.SpecialFolder.ProgramFilesX86), "Steam"));
        foreach (string root in steamRoots.ToArray())
        {
            string libraries = Path.Combine(root, "steamapps", "libraryfolders.vdf");
            if (!File.Exists(libraries)) continue;
            try
            {
                foreach (Match match in Regex.Matches(File.ReadAllText(libraries), "\"path\"\\s*\"([^\"]+)\""))
                    AddPath(steamRoots, match.Groups[1].Value.Replace("\\\\", "\\"));
            }
            catch (IOException) { }
        }

        Engine = FindRunningEngine();
        foreach (string root in steamRoots)
        {
            string common = Path.Combine(root, "steamapps", "common");
            string engineDirectory = Path.Combine(common, "wallpaper_engine");
            string manifest = Path.Combine(root, "steamapps", "appmanifest_431960.acf");
            if (File.Exists(manifest))
            {
                try
                {
                    var name = Regex.Match(File.ReadAllText(manifest), "\"installdir\"\\s*\"([^\"]+)\"").Groups[1].Value;
                    if (name.Length > 0 && name == Path.GetFileName(name)) engineDirectory = Path.Combine(common, name);
                }
                catch (IOException) { }
            }
            Engine ??= InDirectory(engineDirectory);
            Scan(Path.Combine(root, "steamapps", "workshop", "content", "431960"), "创意工坊");
        }
        if (Engine is null) { Projects.Clear(); return; }
        var projects = Path.Combine(Path.GetDirectoryName(Engine)!, "projects");
        Scan(Path.Combine(projects, "myprojects"), "本机项目");
        Scan(Path.Combine(projects, "defaultprojects"), "内置");
        Scan(Path.Combine(projects, "backup"), "本机备份");
    }

    private void Scan(string root, string source)
    {
        if (!Directory.Exists(root)) return;
        string[] directories;
        try { directories = Directory.GetDirectories(root); }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { return; }
        foreach (string directory in directories)
        {
            string project = Path.Combine(directory, "project.json");
            if (!File.Exists(project) || Projects.Count >= 3000) continue;
            try
            {
                if (new FileInfo(project).Length > 2_000_000) continue;
                using var doc = JsonDocument.Parse(File.ReadAllText(project), new JsonDocumentOptions { AllowTrailingCommas = true, CommentHandling = JsonCommentHandling.Skip });
                var data = doc.RootElement;
                string? media = LocalFile(directory, Value(data, "file"));
                string? kind = Value(data, "type")?.ToLowerInvariant();
                kind ??= Path.GetExtension(media)?.ToLowerInvariant() switch
                {
                    ".mp4" or ".webm" => "video",
                    ".html" or ".htm" => "web",
                    ".json" or ".pkg" => "scene",
                    _ => null
                };
                if (kind is not ("scene" or "video" or "web")) continue;
                if (kind == "scene") media = project;
                if (media is null) continue;
                string title = Value(data, "title")?.Trim() is { Length: > 0 } label ? label : Path.GetFileName(directory);
                if (title.Length > 160) title = title[..160];
                string id = Convert.ToHexString(SHA256.HashData(Encoding.UTF8.GetBytes(project.ToUpperInvariant())))[..24];
                string? preview = LocalFile(directory, Value(data, "preview")) ??
                    new[] { "preview.jpg", "preview.png", "preview.gif" }.Select(name => LocalFile(directory, name)).FirstOrDefault(file => file != null);
                Projects[id] = new Wallpaper(id, title, kind, source, media, preview);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException or JsonException or InvalidOperationException or ArgumentException) { }
        }
    }

    private static string? Value(JsonElement item, string key) => item.TryGetProperty(key, out var value) && value.ValueKind == JsonValueKind.String ? value.GetString() : null;

    private static string? LocalFile(string directory, string? relative)
    {
        if (string.IsNullOrWhiteSpace(relative) || Path.IsPathRooted(relative)) return null;
        string path = Path.GetFullPath(Path.Combine(directory, relative));
        return path.StartsWith(directory + Path.DirectorySeparatorChar, StringComparison.OrdinalIgnoreCase) && File.Exists(path) ? path : null;
    }

    private static void AddPath(HashSet<string> roots, string? path)
    {
        if (!string.IsNullOrWhiteSpace(path) && Path.IsPathFullyQualified(path)) roots.Add(Path.GetFullPath(path));
    }

    private static string? InDirectory(string directory) => new[] { "wallpaper64.exe", "wallpaper32.exe" }.Select(name => Path.Combine(directory, name)).FirstOrDefault(File.Exists);

    private static string? FindRunningEngine()
    {
        foreach (string name in new[] { "wallpaper64", "wallpaper32" })
        foreach (var process in Process.GetProcessesByName(name))
        {
            using (process)
            {
                try
                {
                    string? path = process.MainModule?.FileName;
                    if (path is not null && File.Exists(Path.Combine(Path.GetDirectoryName(path)!, "launcher.exe"))) return path;
                }
                catch (Exception error) when (error is System.ComponentModel.Win32Exception or InvalidOperationException) { }
            }
        }
        return null;
    }
}
