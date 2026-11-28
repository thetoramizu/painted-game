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

## MOTUS

MOTUS est sélectionnable depuis le lobby. Sa migration Supabase crée une séquence de 15 mots
commune et un état privé par joueur; les tentatives, le chronomètre et les scores sont validés par
des fonctions PostgreSQL. Le client ne reçoit que son mot courant; la séquence atteinte est révélée
à la fin. Depuis l’écran des résultats, le chef de salle peut relancer une partie (nouvelle séquence,
scores réinitialisés) ou retourner au lobby. Appliquez les migrations au projet Supabase avec
`npx supabase db push`.
Les tests PostgreSQL associés se lancent avec `npx supabase test db`.
Les tentatives et les couleurs du clavier sont réinitialisées à chaque nouveau mot; un joueur peut
passer un mot sans point, sans pouvoir y revenir.

Le dictionnaire embarqué est un sous-ensemble dérivé de **Lexique 4.15**, de New et al. (2026),
téléchargé depuis <https://www.lexique.org/databases/Lexique/Lexique415.zip>. Les formes retenues
sont des entrées alphabétiques de 5 à 7 lettres, de catégories grammaticales usuelles, avec une
fréquence orthographique d’au moins 1 par million. Elles sont dédupliquées après normalisation des
accents. Lexique et ce sous-ensemble sont distribués sous licence **CC BY-SA 4.0**; voir
`supabase/LEXIQUE-LICENSE-CC-BY-SA-4.0.txt`. La licence s’applique aux données lexicales, pas au
code de l’application.

## Running end-to-end tests

For end-to-end (e2e) testing, run:

```bash
ng e2e
```

Angular CLI does not come with an end-to-end testing framework by default. You can choose one that suits your needs.

## Additional Resources

For more information on using the Angular CLI, including detailed command references, visit the [Angular CLI Overview and Command Reference](https://angular.dev/tools/cli) page.
