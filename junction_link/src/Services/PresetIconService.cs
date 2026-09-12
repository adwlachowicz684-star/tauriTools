using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Windows;
using System.Windows.Media;
using System.Windows.Media.Imaging;
using FenPeiXiangMuZu.Models;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 预设图标库服务：管理「项目/项目组修改图标」时可供选择的 .ico 预设。
/// 预设文件落在 数据\preseticons\&lt;显示名&gt;.ico，显示名同时作为文件名主干，
/// 分组与成员由 config.iconGroups 记录，保证稳定且可手工增删。
/// 所有方法均捕获异常返回安全值，绝不抛出导致界面崩溃。
/// </summary>
public sealed class PresetIconService
{
    private readonly AppConfig _config;
    private readonly ConfigService _configSvc;
    private readonly string _dir;

    public PresetIconService(AppConfig config, ConfigService configSvc, string dataDir)
    {
        _config = config;
        _configSvc = configSvc;
        _dir = Path.Combine(dataDir, "preseticons");
        Directory.CreateDirectory(_dir);
    }

    /// <summary>预设图标目录绝对路径（供 UI 展示位置，也供按钮追加文件对话框定位）。</summary>
    public string DirectoryPath => _dir;

    /// <summary>单个预设图标文件的绝对路径。显示名即文件名主干。</summary>
    public string FullPath(string name) => Path.Combine(_dir, name + ".ico");

    /// <summary>所有分组的图标名平铺快照。</summary>
    public List<string> AllIconNames => _config.IconGroups.SelectMany(g => g.Icons).ToList();

    /// <summary>清理：移除各分组中文件已不存在的预设。返回清理后的平铺列表。</summary>
    public List<string> PruneMissing()
    {
        int removed = 0;
        foreach (var g in _config.IconGroups)
            removed += g.Icons.RemoveAll(n => !File.Exists(FullPath(n)));
        if (removed > 0) _configSvc.SaveConfig(_config);
        return AllIconNames;
    }

    // ---- 分组管理 ----

    /// <summary>新增分组（重名自动加序号）。返回新分组名。</summary>
    public string AddGroup(string name)
    {
        var unique = UniqueGroupName(name);
        _config.IconGroups.Add(new IconGroup { Name = unique, Icons = new() });
        _configSvc.SaveConfig(_config);
        return unique;
    }

    /// <summary>校验分组新名（非空 / 不与现有分组重名）。返回错误文案或 null。</summary>
    public string? ValidateGroupName(string? newName)
    {
        var name = (newName ?? "").Trim();
        if (name.Length == 0) return "分组名不能为空。";
        if (_config.IconGroups.Any(g => string.Equals(g.Name, name, StringComparison.OrdinalIgnoreCase)))
            return $"分组「{name}」已存在。";
        return null;
    }

    /// <summary>重命名分组。返回是否成功。</summary>
    public bool RenameGroup(int index, string newName)
    {
        if (index < 0 || index >= _config.IconGroups.Count) return false;
        var err = ValidateGroupName(newName);
        if (err != null) return false;
        _config.IconGroups[index].Name = newName.Trim();
        _configSvc.SaveConfig(_config);
        return true;
    }

    /// <summary>删除分组：组内图标文件一并删除。至少保留一个分组。返回是否成功。</summary>
    public bool DeleteGroup(int index)
    {
        if (_config.IconGroups.Count <= 1) return false;
        if (index < 0 || index >= _config.IconGroups.Count) return false;
        var g = _config.IconGroups[index];
        foreach (var n in g.Icons)
        {
            try { if (File.Exists(FullPath(n))) File.Delete(FullPath(n)); }
            catch { }
        }
        _config.IconGroups.RemoveAt(index);
        _configSvc.SaveConfig(_config);
        return true;
    }

    /// <summary>调整分组顺序。</summary>
    public void MoveGroup(int fromIdx, int toIdx)
    {
        int n = _config.IconGroups.Count;
        if (fromIdx < 0 || fromIdx >= n || toIdx < 0 || toIdx >= n || fromIdx == toIdx) return;
        var item = _config.IconGroups[fromIdx];
        _config.IconGroups.RemoveAt(fromIdx);
        _config.IconGroups.Insert(toIdx, item);
        _configSvc.SaveConfig(_config);
    }

    // ---- 图标导入与管理 ----

    /// <summary>批量导入 .ico 到指定分组：逐个复制进预设目录并按原始文件名取名（重名自动加序号）。返回 (显示名/错误)。</summary>
    public IReadOnlyList<(string Name, string? Error)> Import(IEnumerable<string> files, int groupIndex)
    {
        var results = new List<(string, string?)>();
        if (groupIndex < 0 || groupIndex >= _config.IconGroups.Count)
        {
            groupIndex = 0;
            if (_config.IconGroups.Count == 0)
            {
                _config.IconGroups.Add(new IconGroup { Name = "默认" });
            }
        }
        var group = _config.IconGroups[groupIndex];
        bool changed = false;
        foreach (var f in files)
        {
            var r = ImportOne(f, group.Icons);
            results.Add(r);
            changed |= r.Error == null;
        }
        if (changed) _configSvc.SaveConfig(_config);
        return results;
    }

    /// <summary>从剪贴板位图导入预设图标（转多尺寸 .ico）。返回 (显示名/错误)。</summary>
    public (string Name, string? Error) ImportClipboard(BitmapSource image, int groupIndex, bool insertFront = false)
        => ImportBitmap(image, groupIndex, "剪贴板", insertFront);

    /// <summary>把位图转成多尺寸 .ico 导入预设库（baseName 为图标名主干，重名自动加序号）。返回 (显示名/错误)。</summary>
    public (string Name, string? Error) ImportBitmap(BitmapSource image, int groupIndex, string baseName, bool insertFront = false)
    {
        if (groupIndex < 0 || groupIndex >= _config.IconGroups.Count)
        {
            groupIndex = 0;
            if (_config.IconGroups.Count == 0)
                _config.IconGroups.Add(new IconGroup { Name = "默认" });
        }
        var group = _config.IconGroups[groupIndex];
        var clean = Sanitize(baseName);
        var name = UniqueIconName(string.IsNullOrWhiteSpace(clean) ? "图标" : clean);
        try
        {
            if (!IconConversion.TryConvertToIco(image, FullPath(name)))
                return (name, "图片转换失败");
        }
        catch (Exception)
        {
            return (name, "图片转换失败");
        }
        if (insertFront) group.Icons.Insert(0, name);
        else group.Icons.Add(name);
        _configSvc.SaveConfig(_config);
        return (name, null);
    }

    /// <summary>把位图转成临时 .ico 文件（供不加入预设库时直接应用）。返回文件路径或 null。</summary>
    public static string? WriteTempIco(BitmapSource image)
    {
        var path = Path.Combine(Path.GetTempPath(), $"fenpei_clipboard_{Guid.NewGuid():N}.ico");
        return IconConversion.TryConvertToIco(image, path) ? path : null;
    }

    /// <summary>是否受支持的输入图片文件（供剪贴板文件粘贴过滤）。</summary>
    public static bool IsSupportedFile(string path) => IsSupportedImage(Path.GetExtension(path));

    /// <summary>是否受支持的输入图片格式（.ico 直接入库；png/jpg/jpeg/bmp/gif 自动转 .ico）。</summary>
    private static bool IsSupportedImage(string ext) =>
        ext.Equals(".ico", StringComparison.OrdinalIgnoreCase)
        || ext.Equals(".png", StringComparison.OrdinalIgnoreCase)
        || ext.Equals(".jpg", StringComparison.OrdinalIgnoreCase)
        || ext.Equals(".jpeg", StringComparison.OrdinalIgnoreCase)
        || ext.Equals(".bmp", StringComparison.OrdinalIgnoreCase)
        || ext.Equals(".gif", StringComparison.OrdinalIgnoreCase);

    private (string Name, string? Error) ImportOne(string file, List<string> groupIcons)
    {
        if (string.IsNullOrWhiteSpace(file) || !File.Exists(file))
            return (Path.GetFileName(file) ?? "", "文件不存在");
        var ext = Path.GetExtension(file);
        if (!IsSupportedImage(ext))
            return (Path.GetFileName(file), $"「{Path.GetFileName(file)}」不是受支持的图片格式（支持 ico/png/jpg/jpeg/bmp/gif）");

        var baseName = Sanitize(Path.GetFileNameWithoutExtension(file));
        if (string.IsNullOrEmpty(baseName)) baseName = "icon";
        var name = UniqueIconName(baseName);
        try
        {
            if (ext.Equals(".ico", StringComparison.OrdinalIgnoreCase))
                File.Copy(file, FullPath(name), overwrite: false);
            else if (!IconConversion.TryConvertToIco(file, FullPath(name)))
                return (baseName, $"转换失败: {file}");
        }
        catch (IOException)
        {
            return (baseName, $"复制失败: {file}");
        }
        catch (Exception)
        {
            return (baseName, $"转换失败: {file}");
        }
        groupIcons.Add(name);
        return (name, null);
    }

    /// <summary>生成分组内唯一图标名（重名自动加序号）。</summary>
    private string UniqueIconName(string baseName)
    {
        var allNames = AllIconNames;
        var name = baseName;
        var n = 1;
        while (File.Exists(FullPath(name))
               || allNames.Contains(name, StringComparer.OrdinalIgnoreCase))
        {
            name = $"{baseName}({++n})";
        }
        return name;
    }

    /// <summary>校验图标新名可否用于重命名（非空 / 无非法字符 / 不与现有显示名及磁盘文件冲突）。返回错误文案或 null。</summary>
    public string? ValidateNewName(string? oldName, string? newName)
    {
        var name = (newName ?? "").Trim();
        if (name.Length == 0) return "名称不能为空。";
        if (name == "." || name == "..") return "名称不能为 \".\" 或 \"..\"。";
        if (name.IndexOfAny(Path.GetInvalidFileNameChars()) >= 0)
            return "名称不能包含 \\ / : * ? \" < > | 等字符。";
        var allNames = AllIconNames;
        if (oldName != null
            && allNames.Any(x =>
                !string.Equals(x, oldName, StringComparison.OrdinalIgnoreCase)
                && string.Equals(x, name, StringComparison.OrdinalIgnoreCase)))
            return $"「{name}」已存在。";
        if (!string.Equals(oldName, name, StringComparison.OrdinalIgnoreCase) && File.Exists(Path.Combine(_dir, name + ".ico")))
            return $"文件「{name}.ico」已存在。";
        return null;
    }

    /// <summary>重命名预设：物理改名 + 更新 config 中各分组的引用并落盘。返回是否成功。</summary>
    public bool Rename(string oldName, string newName)
    {
        var err = ValidateNewName(oldName, newName);
        if (err != null) return false;
        if (string.Equals(oldName, newName, StringComparison.Ordinal)) return true;
        try
        {
            File.Move(FullPath(oldName), FullPath(newName));
        }
        catch (Exception)
        {
            return false;
        }
        foreach (var g in _config.IconGroups)
        {
            // 匹配口径与 ValidateNewName 一致用 IgnoreCase：历史数据大小写不一致时也能正确改写引用（防悬空）
            var idx = g.Icons.FindIndex(x => string.Equals(x, oldName, StringComparison.OrdinalIgnoreCase));
            if (idx >= 0) g.Icons[idx] = newName;
        }
        _configSvc.SaveConfig(_config);
        return true;
    }

    /// <summary>删除预设：删除物理文件 + 从所有分组移除并落盘。返回是否成功。</summary>
    public bool Delete(string name)
    {
        try
        {
            if (File.Exists(FullPath(name))) File.Delete(FullPath(name));
        }
        catch (Exception)
        {
            return false;
        }
        foreach (var g in _config.IconGroups)
            g.Icons.RemoveAll(x => x == name);
        _configSvc.SaveConfig(_config);
        return true;
    }

    /// <summary>在分组间移动图标或组内重排。
    /// toIndex 语义：同组时为「移除后落位的最终索引」（0..Count-1，与 ObservableCollection.Move 一致）；
    /// 跨组时为「插入位置」（0..目标 Count）。</summary>
    public void MoveIcon(string iconName, int fromGroup, int toGroup, int toIndex)
    {
        if (fromGroup < 0 || fromGroup >= _config.IconGroups.Count) return;
        if (toGroup < 0 || toGroup >= _config.IconGroups.Count) return;
        var src = _config.IconGroups[fromGroup].Icons;
        var idx = src.FindIndex(x => x == iconName);
        if (idx < 0) return;
        src.RemoveAt(idx);
        // 同列移动：RemoveAt 后后续下标左移一位，toIndex>idx 时需减 1 才落到指示位置
        if (fromGroup == toGroup && toIndex > idx) toIndex--;
        var dst = _config.IconGroups[toGroup].Icons;
        toIndex = Math.Clamp(toIndex, 0, dst.Count);
        dst.Insert(toIndex, iconName);
        _configSvc.SaveConfig(_config);
    }

    /// <summary>生成分组内唯一名。</summary>
    private string UniqueGroupName(string baseName)
    {
        if (string.IsNullOrWhiteSpace(baseName)) baseName = "分组";
        var name = baseName;
        var n = 1;
        while (_config.IconGroups.Any(g => string.Equals(g.Name, name, StringComparison.OrdinalIgnoreCase)))
            name = $"{baseName}({++n})";
        return name;
    }

    /// <summary>去掉文件名主干里对取名为有风险的字符（保留数字字母及 -_）。</summary>
    private static string Sanitize(string name)
    {
        var sb = new System.Text.StringBuilder(name.Length);
        foreach (var c in name)
        {
            sb.Append(char.IsLetterOrDigit(c) || c == '-' || c == '_' ? c : '_');
        }
        var result = sb.ToString().Trim().TrimEnd('_');
        return result.Length == 0 ? "icon" : result;
    }

    /// <summary>加载预设 .ico 的预览图像（取 ICO 内面积最大的一帧），失败返回 null。返回帧已 Freeze，可跨线程使用。</summary>
    public ImageSource? LoadPreview(string name)
    {
        var path = FullPath(name);
        if (!File.Exists(path)) return null;
        try
        {
            using var fs = File.OpenRead(path);
            var dec = BitmapDecoder.Create(fs, BitmapCreateOptions.DelayCreation
                | BitmapCreateOptions.IgnoreColorProfile, BitmapCacheOption.OnLoad);
            if (dec.Frames.Count == 0) return null;
            BitmapFrame? best = null;
            foreach (var fr in dec.Frames)
            {
                if (best == null
                    || (long)fr.PixelWidth * fr.PixelHeight > (long)best.PixelWidth * best.PixelHeight)
                    best = fr;
            }
            if (best == null) return null;
            best.Freeze();
            return best;
        }
        catch
        {
            return null;
        }
    }
}