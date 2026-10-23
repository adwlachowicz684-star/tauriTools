using System.IO;
using FenPeiXiangMuZu.Models;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// 插件装卸服务：把随工具分发的离线插件包（zip）解压安装到运行期目录、
/// 卸载回收、查询状态与定位入口。
/// 布局：
///   <项目根>/资源/<id>.ui.zip        —— 随工具分发的离线包（未安装时不占运行体量）
///   <数据目录>/plugins/<id>/         —— 已安装插件的运行期目录（WebView2 直接加载其入口）
///   <数据目录>/plugins/_offline/<id> —— 卸载时回收的目录（保留离线包，可随时重装）
/// </summary>
public sealed class PluginService
{
    private readonly string _dataDir;
    private readonly AppConfig _config;
    private readonly ConfigService _configSvc;

    /// <summary>受管插件 id（当前唯一：kityminder 思维导图）。</summary>
    public const string KityMinderId = "kityminder";

    public PluginService(string dataDir, AppConfig config, ConfigService configSvc)
    {
        _dataDir = dataDir;
        _config = config;
        _configSvc = configSvc;
    }

    /// <summary>数据目录\plugins 根。</summary>
    private string PluginsRoot => Path.Combine(_dataDir, "plugins");

    /// <summary>某插件运行期目录（数据目录\plugins\<id>）。</summary>
    private string PluginDir(string id) => Path.Combine(PluginsRoot, id);

    /// <summary>卸载回收目录（数据目录\plugins\_offline\<id>）。</summary>
    private string OfflineDir(string id) => Path.Combine(PluginsRoot, "_offline", id);

    /// <summary>从项目根定位离线包的位置：项目根\资源\<id>.ui.zip。项目根 = 数据目录的上级（x 数据\）。</summary>
    private static string OfflineZipPath(string projectRoot) => Path.Combine(projectRoot, "资源", KityMinderId + ".ui.zip");

    /// <summary>插件是否已安装（物理目录存在 + config.installed）。</summary>
    public bool IsInstalled(string id)
    {
        if (!Directory.Exists(PluginDir(id))) return false;
        return _config.Plugins is { } p && p.TryGetValue(id, out var s) && s.Installed;
    }

    /// <summary>获取插件入口的 file:// URI（已安装时）；未安装返回 null。</summary>
    public Uri? GetEntryUri(string id)
    {
        if (!IsInstalled(id)) return null;
        var entry = "index.html";
        if (_config.Plugins is { } p && p.TryGetValue(id, out var s) && !string.IsNullOrWhiteSpace(s.Entry))
            entry = s.Entry;
        var full = Path.Combine(PluginDir(id), entry);
        return File.Exists(full) ? new Uri(full) : null;
    }

    /// <summary>插件运行期目录（数据目录\plugins\<id>）。未安装时仍返回该路径（目录可能不存在）。</summary>
    public string GetInstalledDir(string id) => PluginDir(id);

    /// <summary>
    /// 安装插件：解压离线包到运行期目录并登记 config。项目根用于定位离线包；
    /// 项目根未定/离线包缺失时按未安装处理。返回是否安装成功（已安装则直接 true）。
    /// </summary>
    public bool Install(string id, string projectRoot, string displayName)
    {
        if (IsInstalled(id)) return true;
        var zip = OfflineZipPath(projectRoot);
        if (!File.Exists(zip)) return false;

        // 若此前回收了离线目录，先还原它（含用户编辑过的内容），否则全新解压
        var offline = OfflineDir(id);
        if (Directory.Exists(offline))
        {
            Directory.Move(offline, PluginDir(id));
        }
        else
        {
            var target = PluginDir(id);
            if (Directory.Exists(target)) Directory.Delete(target, true);
            Directory.CreateDirectory(target);
            try { System.IO.Compression.ZipFile.ExtractToDirectory(zip, target); }
            catch
            {
                // 解压失败：清理半成品并中止，避免残留导致重复安装判断错误
                TrySafeDelete(target);
                return false;
            }
        }

        _config.Plugins ??= new Dictionary<string, PluginStatus>(StringComparer.Ordinal);
        _config.Plugins[id] = new PluginStatus { Name = displayName, Installed = true, Entry = "index.html" };
        _configSvc.SaveConfig(_config);
        return true;
    }

    /// <summary>
    /// 卸载插件：移除界面注册并把运行期目录移入回收区（保留用户数据，可随时重装）。
    /// 返回是否完成（未安装则直接 false）。
    /// </summary>
    public bool Uninstall(string id)
    {
        if (!Directory.Exists(PluginDir(id))) return false;
        var offline = OfflineDir(id);
        // 回收目录已有同名残留：先清掉旧残留腾位，避免 Move 冲突
        if (Directory.Exists(offline)) TrySafeDelete(offline);
        Directory.CreateDirectory(Path.GetDirectoryName(offline)!);
        try { Directory.Move(PluginDir(id), offline); }
        catch { return false; }

        if (_config.Plugins is { } p && p.Remove(id))
            _configSvc.SaveConfig(_config);
        return true;
    }

    /// <summary>物理清理插件的全部痕迹（含回收区）。用于彻底移除（可选）。</summary>
    public void Purge(string id)
    {
        TrySafeDelete(PluginDir(id));
        TrySafeDelete(OfflineDir(id));
        if (_config.Plugins is { } p)
        {
            p.Remove(id);
            _configSvc.SaveConfig(_config);
        }
    }

    private static void TrySafeDelete(string path)
    {
        try { if (Directory.Exists(path)) Directory.Delete(path, true); } catch { }
    }
}