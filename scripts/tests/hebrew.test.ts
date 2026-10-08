import { test } from 'node:test';
import assert from 'node:assert/strict';
import { afterPrefix } from '../../shared/hebrew.ts';

test('the article folds into the preposition for «הבית»', () => {
  assert.equal('ל' + afterPrefix('הבית של יוסי'), 'לבית של יוסי');
  assert.equal('ב' + afterPrefix('הבית'), 'בבית');
});

test('a name that only starts with ה keeps it', () => {
  assert.equal(afterPrefix('הדס והבנות'), 'הדס והבנות');
  assert.equal(afterPrefix('הביתן'), 'הביתן');
  assert.equal(afterPrefix('משפחת לוי'), 'משפחת לוי');
});
