import { TestBed } from '@angular/core/testing';
import { PortraitService } from './portrait.service';

describe('PortraitService', () => {
  let service: PortraitService;

  beforeEach(() => {
    TestBed.configureTestingModule({});
    service = TestBed.inject(PortraitService);
  });

  it('generates a face with one element for each required category', () => {
    const model = service.generateModel();
    const categories = new Set(model.elements.map((element) => element.category));
    expect(categories).toContain('left-ear');
    expect(categories).toContain('right-ear');
    expect(categories).toContain('hair');
    expect(categories).toContain('left-eyebrow');
    expect(categories).toContain('right-eyebrow');
    expect(categories).toContain('left-eye');
    expect(categories).toContain('right-eye');
    expect(categories).toContain('nose');
    expect(categories).toContain('mouth');
  });

  it('uses a bounded variant range for every generated element', () => {
    for (let i = 0; i < 100; i += 1) {
      const model = service.generateModel();
      for (const element of model.elements) {
        expect(element.variant).toBeGreaterThanOrEqual(0);
        expect(element.variant).toBeLessThan(6);
        expect(element.svg).toContain('<svg');
      }
    }
  });

  it('keeps every generated position inside the normalized canvas', () => {
    for (let i = 0; i < 100; i += 1) {
      const model = service.generateModel();
      for (const element of model.elements) {
        expect(element.target.x).toBeGreaterThanOrEqual(0);
        expect(element.target.x).toBeLessThanOrEqual(1);
        expect(element.target.y).toBeGreaterThanOrEqual(0);
        expect(element.target.y).toBeLessThanOrEqual(1);
      }
    }
  });

  it('balances interventions across 2 to 4 players without consecutive repeats', () => {
    const model = service.generateModel();
    for (const seatCount of [2, 3, 4]) {
      const seats = Array.from({ length: seatCount }, (_, index) => index);
      const turns = service.createTurnSequence(model, seats);
      expect(turns.length).toBe(model.elements.length * 2);

      const counts = new Map<number, number>();
      let previous = -1;
      for (const turn of turns) {
        counts.set(turn.seat, (counts.get(turn.seat) ?? 0) + 1);
        expect(turn.seat).not.toBe(previous);
        previous = turn.seat;
      }
      const values = [...counts.values()];
      expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
    }
  });

  it('creates elements in a shuffled placement order', () => {
    const model = service.generateModel();
    const turns = service.createTurnSequence(model, [0, 1]);
    const elementOrder = turns
      .filter((turn) => turn.step === 'x')
      .map((turn) => turn.elementId);
    expect(new Set(elementOrder).size).toBe(model.elements.length);
  });

  it('scores an exact reconstruction at 100 percent', () => {
    const model = service.generateModel();
    const placements = Object.fromEntries(model.elements.map((element) => [element.id, element.target]));
    expect(service.calculateScore(model, placements)).toBe(100);
  });

  it('scores a distant reconstruction at zero percent', () => {
    const model = service.generateModel();
    const placements = Object.fromEntries(model.elements.map((element) => [
      element.id,
      { x: 1 - element.target.x, y: 1 - element.target.y },
    ]));
    expect(service.calculateScore(model, placements)).toBeLessThan(100);
  });
});
