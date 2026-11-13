import { Component, input, signal } from '@angular/core';

@Component({
  selector: 'app-btn',
  standalone: true,
  template: `
    <button
      type="button"
      class="btn btn-primary"
      [disabled]="disabled() || !label()"
    >
      {{ label() }}
    </button>
  `,
  styles: []
})
export class AppBtn {
  protected readonly label = input.required<string>();
  protected readonly disabled = input<boolean>(false);
}