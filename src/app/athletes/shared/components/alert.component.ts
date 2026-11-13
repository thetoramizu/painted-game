import { Component, input, signal } from '@angular/core';

@Component({
  selector: 'app-alert',
  standalone: true,
  template: `
    <p class="alert" role="alert">{{ message() }}</p>
  `,
  styles: []
})
export class AppAlert {
  protected readonly message = input.required<string>();
}