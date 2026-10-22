# Modèle de données : Simplimo +

```mermaid
erDiagram
  USERS ||--o{ EVENTS : crée
  USERS ||--o{ ITEM_HISTORY : agit
  USERS ||--o{ AUDIT_LOGS : agit
  CATEGORIES ||--o{ ITEMS : classe
  ITEMS ||--o{ ITEM_DOCUMENTS : "notices PDF"
  ITEMS ||--o{ ITEM_HISTORY : journal
  ITEMS ||--o{ EVENT_ITEMS : réservé
  EVENTS ||--o{ EVENT_ITEMS : contient
  USERS { int id PK string username UK string source "local|ldap" string role "admin|manager|technician" bool active }
  CATEGORIES { int id PK string name UK }
  ITEMS { int id PK string code UK string name int category_id FK string kind "serialized|consumable" string status "available|in_event|damaged|missing" string location string serial_number string photo_path int quantity int min_quantity }
  ITEM_DOCUMENTS { int id PK int item_id FK string title string path }
  EVENTS { int id PK string name string location string start_at string end_at string status "planned|out|returned" int created_by FK }
  EVENT_ITEMS { int id PK int event_id FK int item_id FK int qty string out_scanned_at string in_scanned_at string return_state "ok|damaged|missing" string note string photo_path }
  ITEM_HISTORY { int id PK int item_id FK int event_id string action int user_id string at }
  AUDIT_LOGS { int id PK int user_id string action string entity int entity_id string detail string ip string at }
```

Règles clés
- `EVENT_ITEMS` est unique par (événement, article). Le chevauchement de périodes est refusé (HTTP 409) pour les articles `serialized` dont l'autre événement est `planned` ou `out`.
- Départ : article sérialisé passe à `in_event`, consommable décrémenté de `qty`. Retour : `available`, `damaged` ou `missing` ; consommable recrédité.
- Les dates sont stockées en ISO 8601 UTC (texte) pour fonctionner à l'identique sur SQLite et PostgreSQL.
- Les rôles LDAP sont recalculés à chaque connexion depuis `memberOf` (variables `LDAP_GROUP_*`).
