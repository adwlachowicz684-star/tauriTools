using System;
using System.Collections.Generic;
using System.Linq;

namespace FenPeiXiangMuZu.Services;

/// <summary>
/// Agent 连锁动作内置图标库：Segoe MDL2/Fluent 字形精选集，风格与侧边栏图标一致。
/// 新建动作时从未被占用的字形中随机取一个；弹窗按此数组顺序展示。
/// </summary>
public static class ChainIconCatalog
{
    /// <summary>候选字形（MDL2 码位）。</summary>
    public static readonly string[] Glyphs =
    [
        "\uE99A", // 火箭（默认/连锁）
        "\uE9D9", // 诊断
        "\uE8B5", // 整理箭头
        "\uE898", // 部署
        "\uE713", // 设置齿轮
        "\uE70F", // 编辑笔
        "\uE74E", // 保存
        "\uE72C", // 刷新
        "\uE895", // 同步
        "\uE8A5", // 文档
        "\uE7C3", // 页面
        "\uE80F", // 主页
        "\uE823", // 历史
        "\uE896", // 下载
        "\uE8B7", // 文件夹
        "\uE71D", // 全部应用
        "\uE945", // 地球
    ];

    private static readonly Random _rng = new();

    /// <summary>从「未被占用」的字形中随机取一个；全部占用时退化为全库随机。</summary>
    public static string RandomUnused(IEnumerable<string> usedIcons)
    {
        var used = new HashSet<string>(usedIcons, StringComparer.Ordinal);
        var free = Glyphs.Where(g => !used.Contains(g)).ToList();
        var pool = free.Count > 0 ? free : Glyphs.ToList();
        return pool[_rng.Next(pool.Count)];
    }
}
