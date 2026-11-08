/** Convert canonical Comfy mask alpha (transparent selection) to editor selection alpha. */
export function restoreCanvasMaskSelectionPixels(source:Uint8ClampedArray):Uint8ClampedArray{
 const result=new Uint8ClampedArray(source.length);
 for(let i=0;i+3<source.length;i+=4){result[i]=0;result[i+1]=0;result[i+2]=0;result[i+3]=255-source[i+3];}
 return result;
}
