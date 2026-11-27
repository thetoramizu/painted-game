import { Injectable } from '@angular/core';
import type {
  NormalizedPosition,
  PortraitCategory,
  PortraitElement,
  PortraitModel,
  PortraitTurn,
} from '../models/portrait';

interface PlacementZone {
  x: [number, number];
  y: [number, number];
  width: [number, number];
  height: [number, number];
  zIndex: number;
}

const ZONES: Record<PortraitCategory, PlacementZone> = {
  'left-ear': { x: [0.20, 0.24], y: [0.38, 0.43], width: [0.09, 0.12], height: [0.16, 0.19], zIndex: 1 },
  'right-ear': { x: [0.76, 0.80], y: [0.38, 0.43], width: [0.09, 0.12], height: [0.16, 0.19], zIndex: 1 },
  hair: { x: [0.38, 0.62], y: [0.10, 0.16], width: [0.34, 0.42], height: [0.20, 0.26], zIndex: 8 },
  'left-eyebrow': { x: [0.35, 0.39], y: [0.34, 0.38], width: [0.12, 0.15], height: [0.06, 0.07], zIndex: 6 },
  'right-eyebrow': { x: [0.61, 0.65], y: [0.34, 0.38], width: [0.12, 0.15], height: [0.06, 0.07], zIndex: 6 },
  'left-eye': { x: [0.35, 0.39], y: [0.42, 0.46], width: [0.10, 0.12], height: [0.10, 0.13], zIndex: 7 },
  'right-eye': { x: [0.61, 0.65], y: [0.42, 0.46], width: [0.10, 0.12], height: [0.10, 0.13], zIndex: 7 },
  nose: { x: [0.50, 0.50], y: [0.52, 0.58], width: [0.10, 0.13], height: [0.14, 0.18], zIndex: 5 },
  mouth: { x: [0.50, 0.50], y: [0.67, 0.72], width: [0.24, 0.30], height: [0.10, 0.13], zIndex: 6 },
  accessory: { x: [0.50, 0.50], y: [0.56, 0.64], width: [0.30, 0.36], height: [0.08, 0.11], zIndex: 9 },
};

const SVG = {
  'left-ear': (variant: number) => earSvg(variant, false),
  'right-ear': (variant: number) => earSvg(variant, true),
  hair: (variant: number) => `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 170">
    ${[
      '<path d="M20 130Q10 30 130 18q120 12 110 112l-42-50-24 44-34-58-38 58-35-42z" fill="#6d3d2f"/>',
      '<path d="M18 128Q8 28 132 14q116 18 110 114l-36-44-24 18-52-56-30 58-44-28z" fill="#171827"/>',
      '<path d="M22 112Q20 22 130 16q104 8 108 96l-45-34-63 42-62-42z" fill="#c45d36"/>',
      '<path d="M20 130q-8-82 58-104l52 42 52-42q68 22 58 104l-44-44-66 58-66-58z" fill="#d3a83f"/>',
      '<path d="M18 118Q22 20 130 22q108-2 112 96l-45-22q-68-46-136 0z" fill="#4d2a75"/>',
      '<path d="M28 116q-2-62 102-96q104 34 102 96l-34-18q-68-66-136 0z" fill="#6c7f3c"/>',
    ][variant % 6]}
    <path d="M20 130q110 34 220 0" fill="none" stroke="#39251e" stroke-width="8"/>
  </svg>`,
  'left-eyebrow': (variant: number) => eyebrowSvg(variant),
  'right-eyebrow': (variant: number) => eyebrowSvg((variant + 2) % 6),
  'left-eye': (variant: number) => eyeSvg(variant, false),
  'right-eye': (variant: number) => eyeSvg((variant + 1) % 6, true),
  nose: (variant: number) => noseSvg(variant),
  mouth: (variant: number) => mouthSvg(variant),
  accessory: (variant: number) => accessorySvg(variant),
};

@Injectable({ providedIn: 'root' })
export class PortraitService {
  generateModel(): PortraitModel {
    const categories: PortraitCategory[] = [
      'left-ear',
      'right-ear',
      'hair',
      'left-eyebrow',
      'right-eyebrow',
      'left-eye',
      'right-eye',
      'nose',
      'mouth',
    ];
    if (Math.random() < 0.65) categories.push('accessory');
    const elements = categories.flatMap((category, index) => {
      const zone = ZONES[category];
      const variant = Math.floor(Math.random() * 6);
      const width = random(zone.width[0], zone.width[1]);
      const height = random(zone.height[0], zone.height[1]);
      const x = random(zone.x[0], zone.x[1]);
      const y = random(zone.y[0], zone.y[1]);
      return [this.makeElement(category, variant, x, y, width, height, zone.zIndex, index)];
    });
    return { elements: elements.sort((a, b) => a.zIndex - b.zIndex), generatedAt: Date.now() };
  }

  createTurnSequence(model: PortraitModel, seats: number[]): PortraitTurn[] {
    if (!seats.length) return [];
    const orderedElements = [...model.elements];
    shuffle(orderedElements);
    const interventionCount = orderedElements.length * 2;
    const allocation: number[] = [];
    let previous = -1;
    for (let i = 0; i < interventionCount; i += 1) {
      const counts = seats.map((seat) => allocation.filter((value) => value === seat).length);
      let candidates = seats.filter((seat, index) => {
        const minimum = Math.min(...counts);
        return counts[index] === minimum && seat !== previous;
      });
      if (!candidates.length) candidates = seats.filter((seat) => seat !== previous);
      if (!candidates.length) candidates = [...seats];
      const seat = candidates[Math.floor(Math.random() * candidates.length)];
      allocation.push(seat);
      previous = seat;
    }
    return orderedElements.flatMap((element, elementIndex) => {
      const offset = elementIndex * 2;
      return [
        { seat: allocation[offset], elementId: element.id, step: 'x' as const },
        { seat: allocation[offset + 1], elementId: element.id, step: 'y' as const },
      ];
    });
  }

  calculateScore(model: PortraitModel, placements: Record<string, NormalizedPosition>, tolerance = 0.32): number {
    if (!model.elements.length) return 0;
    const scores = model.elements.map((element) => {
      const placement = placements[element.id];
      if (!placement) return 0;
      const distance = Math.hypot(element.target.x - placement.x, element.target.y - placement.y);
      return Math.max(0, 1 - distance / tolerance);
    });
    return Math.round((scores.reduce((sum, score) => sum + score, 0) / scores.length) * 100);
  }

  private makeElement(
    category: PortraitCategory,
    variant: number,
    x: number,
    y: number,
    width: number,
    height: number,
    zIndex: number,
    index: number,
  ): PortraitElement {
    return {
      id: `${category}-${index}`,
      category,
      variant,
      target: { x, y },
      width,
      height,
      zIndex,
      svg: SVG[category](variant),
    };
  }
}

function random(min: number, max: number): number {
  return min + Math.random() * (max - min);
}

function shuffle<T>(values: T[]): void {
  for (let index = values.length - 1; index > 0; index -= 1) {
    const swapIndex = Math.floor(Math.random() * (index + 1));
    [values[index], values[swapIndex]] = [values[swapIndex], values[index]];
  }
}

function earSvg(variant: number, right: boolean): string {
  const mirror = right ? 'transform="translate(100 0) scale(-1 1)"' : '';
  const inner = [
    '<path d="M48 52q30 12 2 38" fill="none" stroke="#c98d67" stroke-width="7"/>',
    '<path d="M42 48q34 36-4 52" fill="none" stroke="#c98d67" stroke-width="7"/>',
    '<path d="M50 44q-20 26 4 58" fill="none" stroke="#c98d67" stroke-width="7"/>',
    '<circle cx="52" cy="78" r="16" fill="none" stroke="#c98d67" stroke-width="7"/>',
    '<path d="M44 48q38 18 12 50l-12-12" fill="none" stroke="#c98d67" stroke-width="7"/>',
    '<path d="M56 46q-26 30 0 54" fill="none" stroke="#c98d67" stroke-width="7"/>',
  ][variant % 6];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 140"><g ${mirror}><ellipse cx="44" cy="70" rx="38" ry="58" fill="#f2c6a0" stroke="#5d3a2a" stroke-width="8"/>${inner}</g></svg>`;
}

function eyebrowSvg(variant: number): string {
  const paths = [
    'M18 48q70-38 144 2',
    'M18 32q72 28 144-10',
    'M18 44q72-58 144 8',
    'M18 48q72 18 144-12',
    'M18 38q72 0 144 26',
    'M18 50q72-76 144 4',
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 180 70"><path d="${paths[variant % 6]}" fill="none" stroke="#4a3025" stroke-width="${10 + variant % 3 * 3}" stroke-linecap="round"/></svg>`;
}

function eyeSvg(variant: number, right: boolean): string {
  const colors = ['#416b64', '#6f7ea7', '#7a5d42', '#477a56', '#8a6a95', '#5a7e9b'];
  const pupilX = 50 + (variant % 3 - 1) * 8;
  const shape = [
    '<ellipse cx="50" cy="50" rx="36" ry="25"/>',
    '<ellipse cx="50" cy="50" rx="36" ry="30"/>',
    '<path d="M12 50q38-38 76 0q-38 38-76 0z"/>',
    '<ellipse cx="50" cy="50" rx="38" ry="22"/>',
    '<path d="M12 54q38-48 76 0q-38 20-76 0z"/>',
    '<ellipse cx="50" cy="50" rx="32" ry="28"/>',
  ][variant % 6];
  const mirrored = right ? 'transform="translate(100 0) scale(-1 1)"' : '';
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 100 100"><g ${mirrored}><g fill="#fff" stroke="#47352d" stroke-width="7">${shape}</g><circle cx="${pupilX}" cy="50" r="13" fill="${colors[variant % 6]}"/><circle cx="${pupilX}" cy="50" r="5" fill="#171827"/></g></svg>`;
}

function noseSvg(variant: number): string {
  const shapes = [
    'M62 12q-42 55-18 105q20 25 44 0',
    'M58 12q30 58 5 105q-30 20-44-2',
    'M62 12q-8 45-24 90q24 32 48 0',
    'M58 12q40 48 10 105q-28 30-52 0',
    'M60 12q-52 62-10 112q34 18 50-10',
    'M60 12q18 62-8 108q-38 20-42-16',
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 120 150"><path d="${shapes[variant % 6]}" fill="#e8b18a" stroke="#8b5d43" stroke-width="8"/><circle cx="42" cy="115" r="9" fill="#9c664e"/><circle cx="82" cy="115" r="9" fill="#9c664e"/></svg>`;
}

function mouthSvg(variant: number): string {
  const shapes = [
    'M20 48q95 66 190 0q-95-32-190 0',
    'M20 38q95 10 190 0q-95 58-190 0',
    'M20 44q95-38 190 0q-95 48-190 0',
    'M20 48q95 74 190-4q-95 12-190 4',
    'M20 42q95 8 190-10q-95 70-190 10',
    'M20 50q95-62 190 0q-95 76-190 0',
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 230 100"><path d="${shapes[variant % 6]}" fill="${variant % 3 === 0 ? '#b94e63' : '#d36f78'}" stroke="#66313a" stroke-width="8"/></svg>`;
}

function accessorySvg(variant: number): string {
  const variants = [
    '<circle cx="65" cy="48" r="30" fill="#fff" fill-opacity=".25" stroke="#24789a" stroke-width="10"/><circle cx="195" cy="48" r="30" fill="#fff" fill-opacity=".25" stroke="#24789a" stroke-width="10"/><path d="M95 48h70" stroke="#24789a" stroke-width="10"/>',
    '<path d="M130 25q-15 55-65 42q38-2 65-42q27 40 65 42q-50 13-65-42" fill="#4a3025" stroke="#39251e" stroke-width="5"/>',
    '<path d="M28 50h204" stroke="#34315c" stroke-width="10"/><rect x="40" y="28" width="62" height="44" rx="18" fill="#f5a623" fill-opacity=".35" stroke="#34315c" stroke-width="8"/><rect x="158" y="28" width="62" height="44" rx="18" fill="#f5a623" fill-opacity=".35" stroke="#34315c" stroke-width="8"/>',
    '<path d="M130 16v68M96 50h68" stroke="#4d2a75" stroke-width="12" stroke-linecap="round"/><circle cx="130" cy="50" r="34" fill="#b58cff" fill-opacity=".2" stroke="#4d2a75" stroke-width="8"/>',
    '<path d="M32 58q98-70 196 0" fill="none" stroke="#3d2c28" stroke-width="12" stroke-linecap="round"/><circle cx="130" cy="66" r="16" fill="#d3a83f" stroke="#3d2c28" stroke-width="6"/>',
    '<path d="M45 50q85-70 170 0" fill="none" stroke="#24789a" stroke-width="10"/><circle cx="130" cy="48" r="28" fill="#61b6cb" fill-opacity=".3" stroke="#24789a" stroke-width="8"/>',
  ];
  return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 260 100">${variants[variant % 6]}</svg>`;
}
