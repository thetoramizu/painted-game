import { Component, input, output } from '@angular/core';

@Component({
  selector: 'app-btn',
  standalone: true,
  template: `
    <button
      [type]="type()"
      [class]="'btn btn-' + variant()"
      [disabled]="disabled() || loading()"
      (click)="clicked.emit($event)"
    >
      @if (loading()) {
        <span class="spinner"></span>
        {{ loadingLabel() || label() }}
      } @else {
        {{ label() }}
      }
    </button>
  `,
  styles: [`
    :host { display: inline-block; }
    .spinner {
      display: inline-block;
      width: 1rem;
      height: 1rem;
      border: 2px solid currentColor;
      border-right-color: transparent;
      border-radius: 50%;
      animation: spin 0.75s linear infinite;
      margin-right: 0.5rem;
      vertical-align: text-bottom;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
  `]
})
export class AppBtn {
  label = input.required<string>();
  variant = input<'primary' | 'secondary' | 'outline' | 'ghost'>('primary');
  type = input<'button' | 'submit'>('button');
  disabled = input<boolean>(false);
  loading = input<boolean>(false);
  loadingLabel = input<string>('');
  
  clicked = output<MouseEvent>();
}