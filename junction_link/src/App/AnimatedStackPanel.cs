using System;
using System.Collections.Generic;
using System.Windows;
using System.Windows.Controls;
using System.Windows.Media;
using System.Windows.Media.Animation;

namespace FenPeiXiangMuZu;

/// <summary>
/// 带「重排滑动」的 StackPanel：子元素因顺序变化产生沿排列轴位移时，
/// 以 0.25s 缓出曲线从当前视觉位置平滑滑到新位置。
/// 用途：项目组集群上下拖动时的实时让位、画布标签条左右拖动时的实时让位
/// （配合 ObservableCollection.Move 保持容器实例）。
/// </summary>
/// <remarks>轴向由 <see cref="StackPanel.Orientation"/> 决定：Vertical=Y 位移，Horizontal=X 位移。
/// 子元素需为 ItemsControl 生成的稳定容器。</remarks>
public class AnimatedStackPanel : StackPanel
{
    private static readonly TimeSpan SlideDuration = TimeSpan.FromMilliseconds(300);

    /// <summary>是否播放让位滑动动画。拖拽分框期间置 false 即时落位，避免蓝条压在滑动中的分框上。</summary>
    public bool AnimateReorder { get; set; } = true;

    /// <summary>每个子元素上一次布局的目标位置（不含滑动偏移），用于计算位移量与续接起点。</summary>
    private readonly Dictionary<UIElement, double> _lastPos = new();

    private bool AxisHorizontal => Orientation == Orientation.Horizontal;

    private static bool IsHorizontalAxis(UIElement c)
        => c is FrameworkElement fe && fe.Parent is AnimatedStackPanel asp && asp.AxisHorizontal;

    private static double GetAxisOffset(UIElement c)
        => IsHorizontalAxis(c) ? GetTranslate(c).X : GetTranslate(c).Y;

    private static void SetAxisOffset(UIElement c, double v)
    {
        var t = GetTranslate(c);
        if (IsHorizontalAxis(c)) t.X = v;
        else t.Y = v;
    }

    /// <summary>被拖拽逻辑钉住的元素：重排时跳过滑动与清偏移，视觉位置由外部直接控制。</summary>
    private readonly HashSet<UIElement> _pinned = new();

    protected override Size ArrangeOverride(Size arrangeSize)
    {
        Size result = base.ArrangeOverride(arrangeSize);

        for (int i = 0; i < Children.Count; i++)
        {
            UIElement c = Children[i];
            double newPos = AxisHorizontal ? VisualTreeHelper.GetOffset(c).X : VisualTreeHelper.GetOffset(c).Y;

            if (_pinned.Contains(c))
            {
                // 被钉住（拖拽跟随中）：布局记录照常更新，视觉偏移由拖拽逻辑全权控制
                _lastPos[c] = newPos;
                continue;
            }

            if (_lastPos.TryGetValue(c, out double oldPos))
            {
                // 位移超过半像素才滑动，避免像素级抖动触发动画
                if (Math.Abs(newPos - oldPos) > 0.5)
                {
                    if (AnimateReorder)
                        SlideTo(c, oldPos + GetAxisOffset(c) - newPos);
                    else
                    {
                        // 拖拽中即时落位：清掉残留动画偏移，直接停在布局目标位
                        var t = GetTranslate(c);
                        t.BeginAnimation(AxisHorizontal ? TranslateTransform.XProperty : TranslateTransform.YProperty, null);
                        SetAxisOffset(c, 0);
                    }
                }
            }
            else
            {
                // 新容器：清除可能残留的动画偏移，确保从正确位置出现
                var t = GetTranslate(c);
                t.BeginAnimation(AxisHorizontal ? TranslateTransform.XProperty : TranslateTransform.YProperty, null);
                SetAxisOffset(c, 0);
            }
            _lastPos[c] = newPos;
        }

        // 清理已移除子元素的记录
        if (_lastPos.Count > Children.Count)
        {
            var present = new HashSet<UIElement>();
            for (int i = 0; i < Children.Count; i++) present.Add(Children[i]);
            foreach (var k in new List<UIElement>(_lastPos.Keys))
                if (!present.Contains(k)) _lastPos.Remove(k);
        }

        return result;
    }

    /// <summary>
    /// 从当前视觉偏移 slideFrom 平滑滑回 0（布局目标位）。
    /// 注意：base 值恒保持 0，起跳点由动画 From 显式提供——
    /// 若把 base 设为 slideFrom，FillBehavior.Stop 完成时会还原回该偏移，导致分框永久停留在中途位置（重叠 bug）。
    /// </summary>
    private void SlideTo(UIElement c, double slideFrom)
    {
        var t = GetTranslate(c);
        var prop = AxisHorizontal ? TranslateTransform.XProperty : TranslateTransform.YProperty;
        t.BeginAnimation(prop, null);                                    // 停旧动画（base 恒为 0）
        var anim = new DoubleAnimation(slideFrom, 0, SlideDuration)
        {
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
            FillBehavior = FillBehavior.Stop,                            // 结束后回归 base 0 = 布局目标位
        };
        t.BeginAnimation(prop, anim);
        SetAxisOffset(c, 0);   // base 立即归零：动画期间渲染由动画接管，Stop 后正确停在布局位（防拖拽偏移交接残留）
    }

    /// <summary>钉住元素：布局变化时不为其播放滑动/清偏移（用于拖拽跟随中的分框）。</summary>
    public void Pin(UIElement c) => _pinned.Add(c);

    /// <summary>解除钉住，恢复该元素的正常让位滑动。</summary>
    public void Unpin(UIElement c) => _pinned.Remove(c);

    /// <summary>拖拽跟随时直接设置视觉偏移：停掉进行中的动画，base 值即为当前偏移量（轴向跟随面板 Orientation）。</summary>
    public static void SetDirectOffset(UIElement c, double offset)
    {
        var t = GetTranslate(c);
        var prop = IsHorizontalAxis(c) ? TranslateTransform.XProperty : TranslateTransform.YProperty;
        t.BeginAnimation(prop, null);
        SetAxisOffset(c, offset);
    }

    /// <summary>把当前视觉偏移平滑回弹到布局位；base 归零，动画结束后稳定停在布局目标位置。</summary>
    public static void SpringBack(UIElement c)
    {
        var t = GetTranslate(c);
        var prop = IsHorizontalAxis(c) ? TranslateTransform.XProperty : TranslateTransform.YProperty;
        double from = GetAxisOffset(c);
        t.BeginAnimation(prop, null);
        if (Math.Abs(from) < 0.5) { SetAxisOffset(c, 0); return; }
        var anim = new DoubleAnimation(from, 0, SlideDuration)
        {
            EasingFunction = new CubicEase { EasingMode = EasingMode.EaseOut },
            FillBehavior = FillBehavior.Stop,
        };
        t.BeginAnimation(prop, anim);
        SetAxisOffset(c, 0);
    }

    /// <summary>取（必要时创建）子元素上的 TranslateTransform。</summary>
    private static TranslateTransform GetTranslate(UIElement c)
    {
        switch (c.RenderTransform)
        {
            case TranslateTransform t:
                return t;
            case TransformGroup g:
                foreach (var tr in g.Children)
                    if (tr is TranslateTransform tt) return tt;
                var added = new TranslateTransform();
                g.Children.Add(added);
                return added;
            case Transform other:
                var grp = new TransformGroup();
                grp.Children.Add(other);
                var composed = new TranslateTransform();
                grp.Children.Add(composed);
                c.RenderTransform = grp;
                return composed;
            default:
                var fresh = new TranslateTransform();
                c.RenderTransform = fresh;
                return fresh;
        }
    }
}
