import { TestBed } from '@angular/core/testing';
import { PaintService } from './paint.service';

describe('PaintService', () => {
  let service: PaintService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PaintService);
  });

  it('reproduces denser seeded spray compositions with two marks for every player color', () => {
    const colors = ['#4f8cff', '#ff6b6b', '#2fbf71', '#f5a623'];
    const model = service.generateModel(4, colors, 123_456);
    const regenerated = service.generateModel(4, colors, 123_456);

    expect(regenerated.seed).toBe(model.seed);
    expect(regenerated.marks).toEqual(model.marks);
    expect(model.marks).toHaveLength(8);
    for (const color of colors) {
      expect(model.marks.filter((mark) => mark.color === color)).toHaveLength(2);
    }
    expect(model.marks.filter((mark) => mark.kind === 'oval')).toHaveLength(2);
    expect(model.marks.filter((mark) => mark.kind === 'sweep')).toHaveLength(6);

    for (const mark of model.marks) {
      expect(colors).toContain(mark.color);
      if (mark.kind === 'sweep') {
        expect(mark.width).toBeGreaterThanOrEqual(0.065);
        expect(mark.width).toBeLessThanOrEqual(0.15);
        expect(mark.points).toHaveLength(6);
      }
      for (const point of mark.points) {
        expect(point.x).toBeGreaterThanOrEqual(0);
        expect(point.x).toBeLessThanOrEqual(1);
        expect(point.y).toBeGreaterThanOrEqual(0);
        expect(point.y).toBeLessThanOrEqual(1);
      }
    }
  });

  it('chooses a reproducible distinct color set for the players', () => {
    const colors = service.generatePlayerColors(4, 987);

    expect(service.generatePlayerColors(4, 987)).toEqual(colors);
    expect(colors).toHaveLength(4);
    expect(new Set(colors).size).toBe(4);
    expect(service.generatePlayerColors(2, 987)).toHaveLength(2);
  });

  it('creates a different composition for a different seed and scales with available colors', () => {
    const colors = ['#4f8cff', '#ff6b6b', '#2fbf71', '#f5a623'];
    const twoPlayerModel = service.generateModel(2, colors.slice(0, 2), 1);
    const fourPlayerModel = service.generateModel(4, colors, 2);
    const differentSeedModel = service.generateModel(4, colors, 3);

    expect(differentSeedModel.marks).not.toEqual(fourPlayerModel.marks);
    expect(twoPlayerModel.marks).toHaveLength(4);
    expect(twoPlayerModel.marks.filter((mark) => mark.kind === 'oval')).toHaveLength(1);
    expect(twoPlayerModel.marks.filter((mark) => mark.kind === 'sweep')).toHaveLength(3);
    for (const color of colors.slice(0, 2)) {
      expect(twoPlayerModel.marks.filter((mark) => mark.color === color)).toHaveLength(2);
    }
    for (const color of colors) {
      expect(fourPlayerModel.marks.some((mark) => mark.color === color)).toBe(true);
    }
  });

  it('scores an identical model and reproduction at 100 percent', () => {
    const image = createImage(120, 72, '#ffffff');
    fillRect(image, 24, 18, 60, 48, '#4f8cff');

    expect(service.calculateSimilarity(image, image)).toBe(100);
  });

  it('scores a blank reproduction at zero and penalizes the wrong color', () => {
    const reference = createImage(120, 72, '#ffffff');
    const blank = createImage(120, 72, '#ffffff');
    const wrongColor = createImage(120, 72, '#ffffff');
    fillRect(reference, 24, 18, 60, 48, '#4f8cff');
    fillRect(wrongColor, 24, 18, 60, 48, '#ff6b6b');

    expect(service.calculateSimilarity(reference, blank)).toBe(0);
    expect(service.calculateSimilarity(reference, wrongColor)).toBeLessThan(100);
  });
});

function createImage(width: number, height: number, background: string): ImageData {
  const image = new ImageData(width, height);
  const color = parseColor(background);
  for (let offset = 0; offset < image.data.length; offset += 4) {
    image.data[offset] = color[0];
    image.data[offset + 1] = color[1];
    image.data[offset + 2] = color[2];
    image.data[offset + 3] = 255;
  }
  return image;
}

function fillRect(image: ImageData, x: number, y: number, width: number, height: number, color: string): void {
  const [red, green, blue] = parseColor(color);
  for (let row = y; row < y + height; row += 1) {
    for (let column = x; column < x + width; column += 1) {
      const offset = (row * image.width + column) * 4;
      image.data[offset] = red;
      image.data[offset + 1] = green;
      image.data[offset + 2] = blue;
      image.data[offset + 3] = 255;
    }
  }
}

function parseColor(color: string): [number, number, number] {
  return [
    Number.parseInt(color.slice(1, 3), 16),
    Number.parseInt(color.slice(3, 5), 16),
    Number.parseInt(color.slice(5, 7), 16),
  ];
}
