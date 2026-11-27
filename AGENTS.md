
# Instructions de développement

## Stack technique
- Angular 22
- TypeScript
- Phaser 3
- HTML5 Canvas
- Supabase
- SQL

## Règles générales
- Utiliser TypeScript strict.
- Respecter l'architecture existante.
- Privilégier les composants réutilisables.
- Éviter la duplication de code.
- Ne pas modifier des fichiers sans comprendre leur rôle.
- Ne pas installer de dépendances sans validation.
- Vérifier les erreurs TypeScript après chaque modification.
- Respecter les conventions Angular modernes.

## Angular
- Utiliser les standalone components.
- Privilégier Signals lorsque pertinent.
- Séparer composants, services et logique métier.
- Respecter les bonnes pratiques de performance.
- Éviter les abonnements RxJS non nettoyés.

## Phaser / Canvas
- Séparer la logique du jeu et l'interface Angular.
- Gérer correctement les scènes Phaser.
- Libérer les ressources lors de la destruction.
- Optimiser les performances du rendu Canvas.
- Éviter les fuites mémoire.

## Supabase
- Utiliser les types TypeScript générés.
- Sécuriser les tables avec RLS.
- Ne jamais exposer la service_role key côté client.
- Utiliser les migrations SQL.
- Ne jamais désactiver les politiques de sécurité pour contourner un problème.

## Qualité
- Vérifier les builds.
- Expliquer les modifications effectuées.
- Ne pas écraser du code existant sans justification.
