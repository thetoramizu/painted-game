export type PortraitCategory =
  | 'left-ear' | 'right-ear'
  | 'hair'
  | 'left-eyebrow' | 'right-eyebrow'
  | 'left-eye' | 'right-eye'
  | 'nose' | 'mouth' | 'accessory';

export type PortraitPhase = 'preparation' | 'observation' | 'reproduction' | 'results';

export interface NormalizedPosition {
  x: number;
  y: number;
}

export interface PortraitElement {
  id: string;
  category: PortraitCategory;
  variant: number;
  target: NormalizedPosition;
  width: number;
  height: number;
  zIndex: number;
  svg: string;
}

export interface PortraitModel {
  elements: PortraitElement[];
  generatedAt: number;
}

export interface PortraitPlacement {
  elementId: string;
  position: NormalizedPosition;
}

export interface PortraitTurn {
  seat: number;
  elementId: string;
  step: 'x' | 'y';
}
