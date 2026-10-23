namespace KityMinderPlugin;

using System.Linq;

/// <summary>
/// kityminder 宿主公开的契约常量：虚拟主域、就绪探针用到的桥接对象名，
/// 以及 core 实际注册的主题 / 布局模板名（供调用方循环或按需切换）。
/// </summary>
public static class KityMinderContract
{
    /// <summary>页面虚拟主机域名（map 到内嵌资源释放目录）。</summary>
    public const string VirtualHost = "kityminder.example";

    /// <summary>桥接门面对象：核心自曝的 window.__minder（importJson/exportJson/execCommand/setTheme/setLayout）。</summary>
    public const string Bridge = "window.__minder";

    /// <summary>原始 Minder 实例：window.__km（用于就绪判定 window.__km.getRoot）。</summary>
    public const string MinderHandle = "window.__km";

    /// <summary>core 已注册的可切换配色主题：值 + 中文名 + 整图背景色 + 中央节点色 + 二级节点色 + 子节点色（经运行时读取核验，另含 -compact/-compat 变体未列）。</summary>
    public static readonly (string Value, string Label, string BackgroundHex, string RootHex, string MainHex, string SubHex)[] ThemeMeta =
    {
        ("fresh-blue",  "清新蓝", "#FBFBFB", "#73A1BF", "#EEF3F6", "#FFFFFF"),
        ("fresh-green", "清新绿", "#FBFBFB", "#73BF76", "#EEF6EE", "#FFFFFF"),
        ("fresh-red",   "清新红", "#FBFBFB", "#BF7373", "#F6EEEE", "#FFFFFF"),
        ("fresh-soil",  "土壤棕", "#FBFBFB", "#BF9373", "#F6F2EE", "#FFFFFF"),
        ("fresh-purple","清新紫", "#FBFBFB", "#7B73BF", "#EFEEF6", "#FFFFFF"),
        ("fresh-pink",  "清新粉", "#FBFBFB", "#BF7394", "#F6EEF2", "#FFFFFF"),
        ("snow",        "雪白",   "#3A4144", "#E9DF98", "#A4C5C0", "#FFFFFF"),
        ("classic",     "经典黄", "#3A4144", "#E9DF98", "#A4C5C0", "#FFFFFF"),
        ("wire",        "线框灰", "#000000", "#999999", "#999999", "#999999"),
        ("fish",        "青色",   "#3A4144", "#E9DF98", "#A4C5C0", "#FFFFFF"),
    };

    /// <summary>core 已注册的布局模板：值 + 中文名（与编辑器【外观】页签模板下拉一致：default/right/filetree/structure/fish-bone/tianpan）。</summary>
    public static readonly (string Value, string Label)[] LayoutMeta =
    {
        ("default",     "思维导图"),
        ("right",       "逻辑结构图"),
        ("filetree",    "目录组织图"),
        ("structure",   "组织结构图"),
        ("fish-bone",   "鱼骨头图"),
        ("tianpan",     "天盘图"),
    };

    /// <summary>仅名称数组（供 KityMinderHost 内部循环切换等场景）。</summary>
    public static readonly string[] Themes = ThemeMeta.Select(x => x.Value).ToArray();
    public static readonly string[] Layouts = LayoutMeta.Select(x => x.Value).ToArray();

    /// <summary>常用编辑命令（execCommand 键，经 core 注册表核验）。</summary>
    public static class Commands
    {
        public const string AppendChildNode = "AppendChildNode";
        public const string AppendSiblingNode = "AppendSiblingNode";
        public const string AppendParentNode = "AppendParentNode";
        public const string RemoveNode = "RemoveNode";
        public const string Undo = "Undo";
        public const string Expand = "Expand";
        public const string Collapse = "Collapse";
    }
}