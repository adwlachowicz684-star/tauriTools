import { makeOcrNode } from '../../types';
import OcrNode from '../../components/OcrNode';
import { OcrInspector } from '../../components/inspectors/OcrInspector';
import { runOcr } from '../../engine/runners/ocr';
import { registerNode } from '../registry';

registerNode({
  type: 'ocr',
  dataKind: 'ocr',
  meta: {
    label: '图片识别 OCR',
    color: '#f472b6',
    category: 'ai',
    idPrefix: 'ocr',
  },
  create: (id, partial) => makeOcrNode(id, (partial ?? {}) as never).data,
  Canvas: OcrNode,
  Inspector: OcrInspector,
  run: runOcr,
});
