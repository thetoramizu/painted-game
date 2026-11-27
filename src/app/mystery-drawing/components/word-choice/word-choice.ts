import { Component, EventEmitter, Input, Output } from '@angular/core';

@Component({
  selector: 'app-word-choice',
  standalone: true,
  templateUrl: './word-choice.html',
  styleUrl: './word-choice.css',
})
export class WordChoice {
  @Input() words: string[] = [];
  @Input() seconds = 0;
  @Input() busy = false;
  @Output() readonly selected = new EventEmitter<string>();
}
