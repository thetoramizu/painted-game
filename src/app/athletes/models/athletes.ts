export type AthleteId = 'genie' | 'cinquieme-roue' | 'slime' | 'docteur-fusee' | 'tremplin-devin';

export interface Athlete {
  id: AthleteId;
  name: string;
  power: string;
}

export const ATHLETES: readonly Athlete[] = [
  {
    id: 'genie',
    name: 'Génie',
    power: 'Au lieu de lancer le dé, il peut avancer de 5 cases.',
  },
  {
    id: 'cinquieme-roue',
    name: 'Cinquième Roue',
    power: 'Tous les athlètes sur sa case, lui compris, gagnent +1 à leur déplacement principal.',
  },
  {
    id: 'slime',
    name: 'Slime',
    power: 'Tous les autres athlètes subissent -1 à leur déplacement principal.',
  },
  {
    id: 'docteur-fusee',
    name: 'Docteur Fusée',
    power: "Au début de son tour, il gagne un jeton Bronze « 1 point » s'il est seul en dernière position.",
  },
  {
    id: 'tremplin-devin',
    name: 'Tremplin-Devin',
    power: 'Quand un athlète s’arrête sur une case avec exactement un autre athlète, il avance de 2 cases.',
  },
];

export function findAthlete(id: string): Athlete | undefined {
  return ATHLETES.find((athlete) => athlete.id === id);
}
