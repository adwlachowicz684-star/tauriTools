using System.Globalization;
using System.Windows;
using System.Windows.Data;

namespace FenPeiXiangMuZu.Converters;

/// <summary>
/// 按钮快捷键提示的显隐（多值折叠）：是否可见 = ShowShortcuts 开 &amp;&amp; 提示文本非空
/// &amp;&amp; （若提供了第三个 bool 值则其必须为 true，用于侧边栏收起时隐藏）。
/// 顺序：ShowShortcuts(bool) / 提示文本(string) / 可选展开态(bool)。
/// </summary>
public sealed class ShortcutHintVisibilityConverter : IMultiValueConverter
{
    public object Convert(object[] values, Type targetType, object parameter, CultureInfo culture)
    {
        if (values.Length >= 2
            && values[0] is true
            && values[1] is string s
            && s.Length > 0
            && (values.Length < 3 || values[2] is not bool b || b))
            return Visibility.Visible;
        return Visibility.Collapsed;
    }

    public object[] ConvertBack(object value, Type[] targetTypes, object parameter, CultureInfo culture)
        => throw new NotSupportedException();
}