import { makeTranslateNode } from '../../types';
import TranslateNode from '../../components/TranslateNode';
import { TranslateInspector } from '../../components/inspectors/TranslateInspector';
import { runTranslate } from '../../engine/runners/translate';
import { registerNode } from '../registry';

registerNode({
  type: 'translate',
  dataKind: 'translate',
  meta: {
    label: '翻译',
    color: '#38bdf8',
    category: 'ai',
    idPrefix: 'ty',
  },
  create: (id, partial) => makeTranslateNode(id, (partial ?? {}) as never).data,
  Canvas: TranslateNode,
  Inspector: TranslateInspector,
  run: runTranslate,
});
