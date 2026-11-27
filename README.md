# PaintedGame

This project was generated using [Angular CLI](https://github.com/angular/angular-cli) version 22.2.5.

## Development server

To start a local development server, run:

```bash
ng serve
```

Once the server is running, open your browser and navigate to `http://localhost:4200/`. The application will automatically reload whenever you modify any of the source files.

## Code scaffolding

Angular CLI includes powerful code scaffolding tools. To generate a new component, run:

```bash
ng generate component component-name
```

For a complete list of available schematics (such as `components`, `directives`, or `pipes`), run:

```bash
ng generate --help
```

## Building

To build the project run:

```bash
ng build
```

This will compile your project and store the build artifacts in the `dist/` directory. By default, the production build optimizes your application for performance and speed.

## Running unit tests

To execute unit tests with the [Vitest](https://vitest.dev/) test runner, use the following command:

```bash
ng test
```

## Dessin Mystère

Le mini-jeu est disponible depuis le lobby. Ses migrations Supabase se trouvent dans
`supabase/migrations/` et doivent être appliquées au projet lié avec
`npx supabase db push`. Les mots français sont administrés dans `mystery_word_bank`; les délais
(choix, dessin, récapitulatif et reconnexion) sont configurés dans `mystery_settings`.
Les salons déjà créés avant cette migration doivent être recréés pour ce mode : l’ancien schéma ne
persistait pas le jeton de joueur nécessaire à l’autorisation serveur.

Les propositions et le mot secret sont conservés côté base de données. Le dessin apparaît
immédiatement sur la toile du dessinateur, puis est synchronisé par événements validés côté serveur
et rechargé depuis les événements persistés à la reconnexion. Aucune capture de toile n’est envoyée
à chaque mouvement.

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
