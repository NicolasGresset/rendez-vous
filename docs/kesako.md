# l'idée de l'outil

3 amis veulent trouver un bar pour se retrouver ce soir, mais ils ne veulent pas mettre trop de temps pour s'y rendre. rendez-vous détermine le _meilleur_ lieu pour le groupe, quelque soit le mode de transport de chacun.


# first step : adresse de chacun

parler de la recherche améliorée via la bdd locale et l'IGN et des ptits optis qu'on a rajouté pour améliorer l'UX (e.g. fautes d'ortographes, fuzzy finding, cliquer sur la carte et recherche inverse)

# second step : calcul


L'objectif est de trouver le lieu qui minimise la somme des temps porte à porte pour s'y rendre pour le groupe.
Ce problème de minimisation a été considéré depuis longtemps : on introduit le point de fermat weber pour le plan euclidien, et l'algorithme itératif qui permet d'en trouver une bonne approximation (et qui converge en fait). Puis on explique que ça fonctionne bien pour une distance euclidienne, mais que le temps porte à porte se comporte différemment.

MAIS : le temps porte à porte dépend du mode de transport évidemment, et dans une ville ne suit pas du tout la distance à vol d'oiseau (mettre exemple à pied avec la garonne : le détour fait qu'on met plus de temps que la distance, faire un autre exemple avec les transports en commun)

Comment on fait alors ?

Heureusement pour nous, la liste candidate des lieux est finie, donc le problème change de nature. On dit il y a combien de bars dans Toulouse que l'on considère pour notre problème. 
On explique que pour calculer les temps de trajet door to door, on peut utiliser openrouteservices en API gratuite et transitous / tisseo pour le mode de transport mais on rappelle les vraies problématiques de temps qui existent.

On propose alors de n'évaluer que quelques lieux autour du barycentre de chacun des points (c'est ce qu'on a fait pendant un long moment), ça permet de réduire les temps de calcul, et on redonne le meilleur, sans aucune garantie d'optimum.

On explique ensuite qu'il est trop compliqué pour avoir un bon résultat de se limiter à une petite dizaine d'évaluations, d'où l'idée d'héberger MOTIS sur un home server.

Ensuite on passe à la