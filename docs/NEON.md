# התפקיד שאיתו מתחברים ל-Neon

> אם ראיתם את ההודעה **«ההפרדה בין בתים לא פעילה במסד הנתונים הזה»** —
> הדף הזה הוא התיקון, וזה לוקח שלוש דקות.

---

## מה קרה

אבטחת שורות (RLS) היא מה שמפריד בין בתים בקאסה. Postgres **מתעלם ממנה לחלוטין**
עבור תפקיד שהוא `superuser` או שיש לו `BYPASSRLS` — כל מדיניות עדיין רשומה, כל
טבלה עדיין מדווחת `rowsecurity = true`, ושום דבר בשום מקום לא מתלונן. הסימפטום
היחיד הוא בית אחד שקורא את הכסף של בית אחר.

**תפקיד ברירת המחדל של Neon, `neondb_owner`, נוצר עם `BYPASSRLS`.**

לכן:

- **הרצת המיגרציה שוב לא תעזור, ולעולם לא תעזור.** המיגרציה יוצרת את המדיניות
  נכון בכל פעם. הבעיה היא בתפקיד שמתחבר, לא בסכימה.
- התפקיד גם לא יכול להסיר את התכונה מעצמו. נבדק:
  `ALTER ROLE neondb_owner NOBYPASSRLS` → `ERROR: permission denied to alter role`.

התיקון הוא תפקיד אפליקציה ייעודי, בלי `BYPASSRLS`.

---

## התיקון

### 1. בחרו סיסמה

משהו אקראי וארוך. אפשר לייצר אחת כך, או בכל מחולל סיסמאות:

```bash
openssl rand -base64 24
```

### 2. הריצו את זה ב-Neon → SQL Editor

**בתור `neondb_owner`**, על מסד הנתונים של קאסה. החליפו את `הסיסמה-שלכם`:

```sql
CREATE ROLE casa_app LOGIN PASSWORD 'הסיסמה-שלכם'
  NOSUPERUSER NOBYPASSRLS NOCREATEDB NOCREATEROLE;

-- כדי שנוכל להעביר לו בעלות בשלב הבא
GRANT casa_app TO neondb_owner;

-- הבעלות על הטבלאות עוברת אליו: בלעדיה המיגרציה הבאה תיכשל,
-- כי ALTER TABLE דורש בעלות. הנתונים עצמם לא זזים ולא משתנים.
REASSIGN OWNED BY neondb_owner TO casa_app;

GRANT USAGE, CREATE ON SCHEMA public TO casa_app;
```

### 3. אמתו — לפני שנוגעים ב-Vercel

עדיין ב-SQL Editor:

```sql
SELECT rolname, rolsuper, rolbypassrls FROM pg_roles WHERE rolname = 'casa_app';
```

חייב להחזיר `f` ו-`f`. אם לא — עצרו כאן.

### 4. עדכנו את `DATABASE_URL` ב-Vercel

קחו את המחרוזת הקיימת והחליפו בה **רק את שם המשתמש והסיסמה**:

```
postgresql://neondb_owner:הישנה@ep-xxx-pooler.eu-central-1.aws.neon.tech/casa?sslmode=require
                ↓
postgresql://casa_app:הסיסמה-שלכם@ep-xxx-pooler.eu-central-1.aws.neon.tech/casa?sslmode=require
```

**השאירו את המארח בדיוק כפי שהוא**, כולל ה-`-pooler` ו-`sslmode=require`.

### 5. רידפלוי, ואז בדקו

«הגדרות» ← «מסד הנתונים» ← **«הפרדה בין בתים»** צריך לומר **«נאכפת»**.

---

## מה נבדק, ואיך

הרצף כולו הורץ מול Postgres 16 מקומי שמשחזר את המצב של Neon — תפקיד בעלים
שאינו superuser אך יש לו `BYPASSRLS`:

| | לפני | אחרי |
|---|---|---|
| `row_security_active('accounts')` | `false` | `true` |
| בית 1 רואה את החשבון של בית 2 | **כן** | לא |
| חיבור בלי בית רואה | הכול | 0 שורות |
| כתיבה לבית אחר | מצליחה | `ERROR: new row violates row-level security policy` |
| המיגרציה רצה שוב | ✔ | ✔ |
| הנתונים אחרי `REASSIGN` | — | ללא שינוי |

`REASSIGN OWNED` מעביר בעלות בלבד. הוא אינו מעתיק, אינו מוחק ואינו נוגע בשורות.

---

## למה זה לא נתפס קודם

הבדיקה הראשונה של הבידוד רצה בתור superuser ו**עברה את כל המבחנים** — מפני
שהיא ראתה הכול. זה מה שהוליד את `proveIsolation` ב-`api/_lib/db.ts`: המערכת
מסרבת לשרת מסד שבו ההפרדה אינה פועלת, במקום להגיש בשקט את הנתונים של כולם.

הבדיקות ב-`scripts/tests/isolation.test.ts` אומתו משני הכיוונים — כולן עוברות
מול תפקיד רגיל, ושש מהן נכשלות מול תפקיד שעוקף RLS. לכן `CASA_TEST_DATABASE_URL`
חייב להצביע על תפקיד רגיל: אחרת הבדיקות יעברו מהסיבה הלא נכונה.
