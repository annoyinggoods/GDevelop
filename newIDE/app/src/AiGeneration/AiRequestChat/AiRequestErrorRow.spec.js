/**
 * @jest-environment jsdom
 */
// @flow
import * as React from 'react';
import TestRenderer from 'react-test-renderer';
// react-test-renderer's flow-typed definition does not declare `act`: use
// the one from react-dom (the same function React re-exports).
import { act } from 'react-dom/test-utils';
import { I18nProvider } from '@lingui/react';
import { setupI18n } from '@lingui/core';
import { AiRequestErrorRow } from './AiRequestErrorRow';

// An empty catalogs set makes the components render the English (source)
// messages, like the app does with GDI18nProvider for an untranslated lang.
const i18n = setupI18n({ language: 'en', catalogs: {} });

const renderRow = (error: ?{| code: string, message: string |}) => {
  let component;
  act(() => {
    component = TestRenderer.create(
      <I18nProvider i18n={i18n} language="en">
        <AiRequestErrorRow
          error={error}
          onRetry={jest.fn()}
          onStartNewChat={jest.fn()}
        />
      </I18nProvider>
    );
  });
  if (!component) throw new Error('The row did not render');
  return component;
};

describe('AiRequestErrorRow', () => {
  it('maps byok-empty-answer to its dedicated heading and offers retry', () => {
    const component = renderRow({
      code: 'byok-empty-answer',
      message: 'The model returned an empty answer. Try again.',
    });

    const renderedJson = JSON.stringify(component.toJSON());
    expect(renderedJson).toContain('The model returned an empty answer.');
    // The retryable kind is kept: the Retry action is offered.
    expect(renderedJson).toContain('Retry');
  });

  it('keeps the generic transient heading for unmapped codes', () => {
    const component = renderRow({
      code: 'some-unknown-code',
      message: 'Something went wrong.',
    });

    const renderedJson = JSON.stringify(component.toJSON());
    expect(renderedJson).toContain('The AI ran into an error');
    expect(renderedJson).not.toContain('The model returned an empty answer.');
  });

  it('keeps the too-large mapping for byok-context-full', () => {
    const component = renderRow({
      code: 'byok-context-full',
      message: 'The conversation is close to the context window limit.',
    });

    const renderedJson = JSON.stringify(component.toJSON());
    expect(renderedJson).toContain('This chat is too long');
    // Too-large chats cannot be retried, whatever the chat allows.
    expect(renderedJson).not.toContain('Retry');
  });
});
