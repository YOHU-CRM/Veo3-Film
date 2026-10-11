export { analyzeImage, dilateBox, pullPushFill } from './analyze';
export type { AnalysisResult, MotionBlock, BlockKind, RGBAImage } from './analyze';
export { buildPlan, stateAt, kenBurns } from './plan';
export type { MotionPlan, MotionStyle, BlockPlan, BlockState } from './plan';
export { ImageMotionScene, prepareImage, fitRect, defaultCanvasFactory } from './renderer';
export type { PreparedImage, CanvasFactory, Rect, Ctx2D, AnyCanvas } from './renderer';
export { createBackdrop, drawImageSceneFrame } from './compose';
export type { Backdrop, FitMode } from './compose';
