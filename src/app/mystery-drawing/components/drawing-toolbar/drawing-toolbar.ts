import { Component, EventEmitter, Input, Output } from '@angular/core';
import type { DrawingOperation, DrawingTool, ToolbarAction } from '../../models/mystery-drawing';

const COLORS = [
  '#171717', '#ffffff', '#858585', '#e53935', '#fb8c00', '#fdd835',
  '#43a047', '#1e88e5', '#4fc3f7', '#8e24aa', '#ec407a', '#795548',
];

@Component({
  selector: 'app-drawing-toolbar',
  standalone: true,
  templateUrl: './drawing-toolbar.html',
  styleUrl: './drawing-toolbar.css',
})
export class DrawingToolbar {
  @Input() disabled = true;
  @Input() selectedColor = '#171717';
  @Input() selectedSize = 8;
  @Input() selectedTool: DrawingTool = 'brush';
  @Output() readonly colorChange = new EventEmitter<string>();
  @Output() readonly sizeChange = new EventEmitter<number>();
  @Output() readonly toolChange = new EventEmitter<DrawingTool>();
  @Output() readonly action = new EventEmitter<ToolbarAction>();

  protected readonly colors = COLORS;
  protected readonly sizes = [
    { label: 'Petit', value: 4 },
    { label: 'Moyen', value: 8 },
    { label: 'Grand', value: 18 },
  ];

  protected emitAction(kind: DrawingOperation): void {
    if (kind === 'clear' && !window.confirm('Effacer tout le dessin de cette manche ?')) return;
    this.action.emit({ kind, payload: {} });
  }
}
