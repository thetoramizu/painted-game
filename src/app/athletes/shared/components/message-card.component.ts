import { Component, input, signal } from '@angular/core';

@Component({
  selector: 'app-message-card',
  standalone: true,
  template: `
    <div class="message-card">
      <ng-content></ng-content>
    </div>
  `,
  styles: []
})
export class AppMessageCard {
  protected readonly title = input<string>('');
  protected readonly show = input<boolean>(true);
}