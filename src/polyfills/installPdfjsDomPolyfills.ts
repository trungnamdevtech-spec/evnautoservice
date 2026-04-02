// @ts-nocheck — stub DOM toàn cục cho pdfjs trên Node; không cần khớp lib.dom đầy đủ
/**
 * pdfjs-dist (qua pdf-parse v2) cần DOMMatrix/ImageData/Path2D khi chạy Node thuần (Docker / Linux).
 * Import module này trước mọi import tới `pdf-parse` (vd. ElectricityBillParser).
 */
const g = globalThis;

if (typeof g.DOMMatrix === "undefined") {
  g.DOMMatrix = class DOMMatrix {
    constructor() {}
  };
}
if (typeof g.DOMMatrixReadOnly === "undefined") {
  g.DOMMatrixReadOnly = g.DOMMatrix;
}
if (typeof g.ImageData === "undefined") {
  g.ImageData = class ImageData {
    constructor() {}
  };
}
if (typeof g.Path2D === "undefined") {
  g.Path2D = class Path2D {
    constructor() {}
  };
}
