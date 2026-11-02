/**
 * @jest-environment jsdom
 */
// @flow

// jsdom does not implement matchMedia, which PreferencesContext.js calls at
// module load to choose the default theme. It must be polyfilled BEFORE the
// modules below are loaded — hence the `require`s instead of imports.
if (!(window: any).matchMedia) {
  (window: any).matchMedia = (query: string) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => {},
  });
}

const React = require('react');
const TestRenderer = require('react-test-renderer');
// react-test-renderer's flow-typed definition does not declare `act`.
const { act } = require('react-dom/test-utils');
const { I18nProvider } = require('@lingui/react');
const { setupI18n } = require('@lingui/core');
const PreferencesContext = require('../../MainFrame/Preferences/PreferencesContext')
  .default;
const {
  SubscriptionContext,
} = require('../../Profile/Subscription/SubscriptionContext');
const AuthenticatedUserContext = require('../../Profile/AuthenticatedUserContext')
  .default;
const UnsavedChangesContext = require('../../MainFrame/UnsavedChangesContext')
  .default;
const { ChatMessages } = require('./ChatMessages');
const { OrchestratorPlan } = require('./OrchestratorPlan');
const { registerByokImage, getByokImage } = require('../Byok/ByokImageContent');

// An empty catalogs set makes the components render the English (source)
// messages, like the app does with GDI18nProvider.
const i18n = setupI18n({ language: 'en', catalogs: {} });

// The transcript shared by the tests: one user message, one assistant
// answer — enough for the feedback buttons to have somewhere to attach.
const makeSimpleAiRequest = () => ({
  id: 'byok-test-chat',
  mode: 'orchestrator',
  status: 'ready',
  error: null,
  gameId: null,
  output: [
    {
      type: 'message',
      status: 'completed',
      role: 'user',
      content: [
        { type: 'user_request', status: 'completed', text: 'Make a game' },
      ],
    },
    {
      type: 'message',
      status: 'completed',
      role: 'assistant',
      content: [
        {
          type: 'output_text',
          status: 'completed',
          text: 'Here is your game!',
          annotations: [],
        },
      ],
    },
  ],
});

const renderChat = ({ aiRequest, ...props }: any) => {
  const defaultProps = {
    editorFunctionCallResults: null,
    onScrollToBottom: (jest.fn(): any),
    hasStartedRequestButCannotContinue: false,
    onStartOrOpenChat: (jest.fn(): any),
    savingProjectForMessageId: null,
    forkingState: null,
    onRestore: (jest.fn(): any),
    shouldDisplayFeedbackBanner: true,
  };
  let component;
  act(() => {
    component = TestRenderer.create(
      <I18nProvider i18n={i18n} language="en">
        <PreferencesContext.Provider
          value={
            ({
              values: { automaticallyUseCreditsForAiRequests: true },
              setMultipleValues: (jest.fn(): any),
            }: any)
          }
        >
          <SubscriptionContext.Provider
            value={
              ({
                getSubscriptionPlansWithPricingSystems: () => [],
                openSubscriptionDialog: (jest.fn(): any),
              }: any)
            }
          >
            <AuthenticatedUserContext.Provider
              value={
                ({
                  profile: null,
                  subscription: null,
                  limits: null,
                }: any)
              }
            >
              <UnsavedChangesContext.Provider
                value={({ hasUnsavedChanges: false }: any)}
              >
                <ChatMessages
                  aiRequest={aiRequest}
                  {...defaultProps}
                  {...props}
                />
              </UnsavedChangesContext.Provider>
            </AuthenticatedUserContext.Provider>
          </SubscriptionContext.Provider>
        </PreferencesContext.Provider>
      </I18nProvider>
    );
  });
  if (!component) throw new Error('The chat did not render');
  return component;
};

describe('ChatMessages: like/dislike buttons (O1)', () => {
  it('hides the feedback buttons when onSendFeedback is not provided (BYOK)', () => {
    const component = renderChat({ aiRequest: makeSimpleAiRequest() });

    const renderedJson = JSON.stringify(component.toJSON());
    expect(renderedJson).toContain('Here is your game!');
    expect(renderedJson).not.toContain('Did it work?');
  });

  it('still shows the feedback buttons on hosted chats (onSendFeedback provided)', () => {
    const component = renderChat({
      aiRequest: makeSimpleAiRequest(),
      onSendFeedback: (jest.fn(): any).mockResolvedValue(undefined),
    });

    const renderedJson = JSON.stringify(component.toJSON());
    expect(renderedJson).toContain('Did it work?');
  });
});

describe('ChatMessages: process-function-calls affordances (O13)', () => {
  const makePlanAiRequest = () => ({
    id: 'byok-test-chat',
    mode: 'orchestrator',
    status: 'ready',
    error: null,
    gameId: null,
    output: [
      {
        type: 'function_call_output',
        call_id: 'call-plan-1',
        output: JSON.stringify({
          success: true,
          plan: {
            tasks: [
              { id: 'task-1', title: 'Create the player', status: 'pending' },
            ],
          },
        }),
      },
    ],
  });

  it('provides no process callback to the plan on a BYOK chat (prop absent)', () => {
    const component = renderChat({
      aiRequest: makePlanAiRequest(),
      getToolResultImage: undefined,
    });

    const planComponents = component.root.findAllByType(OrchestratorPlan);
    expect(planComponents).toHaveLength(1);
    expect(planComponents[0].props.onProcessFunctionCalls).toBe(undefined);
  });

  it('still wires the process callback on hosted chats (prop provided)', () => {
    const onProcessFunctionCalls = (jest.fn(): any).mockResolvedValue(
      undefined
    );
    const component = renderChat({
      aiRequest: makePlanAiRequest(),
      onProcessFunctionCalls,
    });

    const planComponents = component.root.findAllByType(OrchestratorPlan);
    expect(planComponents).toHaveLength(1);
    expect(planComponents[0].props.onProcessFunctionCalls).toBe(
      onProcessFunctionCalls
    );
  });
});

describe('ChatMessages: tool result images (O4)', () => {
  it('renders the images a BYOK tool output references', () => {
    const image = registerByokImage({
      dataUrl: 'data:image/jpeg;base64,fakeimagebytes',
      width: 320,
      height: 200,
    });
    const aiRequest = {
      id: 'byok-test-chat',
      mode: 'orchestrator',
      status: 'ready',
      error: null,
      gameId: null,
      output: [
        {
          type: 'function_call_output',
          call_id: 'call-shot-1',
          output: JSON.stringify({ success: true, message: 'Captured.' }),
          images: [image.id],
        },
      ],
    };

    const component = renderChat({
      aiRequest,
      getToolResultImage: getByokImage,
    });

    // The chat also renders an avatar <img> (Gravatar): count only the
    // tool-result screenshots by their alt text.
    const imageElements = component.root.findAll(
      element =>
        element.type === 'img' &&
        element.props.alt === 'Screenshot returned by a tool call'
    );
    expect(imageElements).toHaveLength(1);
    expect(imageElements[0].props.src).toBe(image.dataUrl);
  });

  it('never renders images without the lookup prop (hosted chats)', () => {
    const image = registerByokImage({
      dataUrl: 'data:image/jpeg;base64,fakeimagebytes2',
      width: 320,
      height: 200,
    });
    const aiRequest = {
      id: 'server-test-chat',
      mode: 'orchestrator',
      status: 'ready',
      error: null,
      gameId: null,
      output: [
        {
          type: 'function_call_output',
          call_id: 'call-shot-2',
          output: JSON.stringify({ success: true, message: 'Captured.' }),
          images: [image.id],
        },
      ],
    };

    const component = renderChat({ aiRequest });

    // The chat also renders an avatar <img> (Gravatar): count only the
    // tool-result screenshots by their alt text.
    const imageElements = component.root.findAll(
      element =>
        element.type === 'img' &&
        element.props.alt === 'Screenshot returned by a tool call'
    );
    expect(imageElements).toHaveLength(0);
  });

  it('renders nothing for an image id the store does not know (e.g. reload)', () => {
    const aiRequest = {
      id: 'byok-test-chat',
      mode: 'orchestrator',
      status: 'ready',
      error: null,
      gameId: null,
      output: [
        {
          type: 'function_call_output',
          call_id: 'call-shot-3',
          output: JSON.stringify({ success: true, message: 'Captured.' }),
          images: ['byok-img-gone-after-reload'],
        },
      ],
    };

    const component = renderChat({
      aiRequest,
      getToolResultImage: getByokImage,
    });

    // The chat also renders an avatar <img> (Gravatar): count only the
    // tool-result screenshots by their alt text.
    const imageElements = component.root.findAll(
      element =>
        element.type === 'img' &&
        element.props.alt === 'Screenshot returned by a tool call'
    );
    expect(imageElements).toHaveLength(0);
  });

  it('renders a plain text-only transcript unchanged', () => {
    const component = renderChat({
      aiRequest: makeSimpleAiRequest(),
      getToolResultImage: getByokImage,
    });

    // The chat also renders an avatar <img> (Gravatar): count only the
    // tool-result screenshots by their alt text.
    const imageElements = component.root.findAll(
      element =>
        element.type === 'img' &&
        element.props.alt === 'Screenshot returned by a tool call'
    );
    expect(imageElements).toHaveLength(0);
    expect(JSON.stringify(component.toJSON())).toContain('Here is your game!');
  });
});

describe('ChatMessages: user message attached images (Phase 13.3)', () => {
  it('renders the images attached to a user message, after the message', () => {
    const image = registerByokImage({
      dataUrl: 'data:image/png;base64,fakeattachedbytes',
      width: 280,
      height: 280,
    });
    const aiRequest = {
      id: 'byok-test-chat',
      mode: 'orchestrator',
      status: 'ready',
      error: null,
      gameId: null,
      output: [
        {
          type: 'message',
          status: 'completed',
          role: 'user',
          content: [
            {
              type: 'user_request',
              status: 'completed',
              text: 'What is on this picture?',
            },
          ],
          images: [image.id],
        },
      ],
    };

    const component = renderChat({
      aiRequest,
      getToolResultImage: getByokImage,
    });

    const imageElements = component.root.findAll(
      element =>
        element.type === 'img' &&
        element.props.alt === 'Attachment sent with the message'
    );
    expect(imageElements).toHaveLength(1);
    expect(imageElements[0].props.src).toBe(image.dataUrl);
  });

  it('renders nothing for attachments without the lookup prop (hosted side)', () => {
    const aiRequest = {
      id: 'server-test-chat',
      mode: 'orchestrator',
      status: 'ready',
      error: null,
      gameId: null,
      output: [
        {
          type: 'message',
          status: 'completed',
          role: 'user',
          content: [
            {
              type: 'user_request',
              status: 'completed',
              text: 'Hello',
            },
          ],
          images: ['img-only-byok-would-know'],
        },
      ],
    };

    const component = renderChat({ aiRequest });
    expect(
      component.root.findAll(
        element =>
          element.type === 'img' &&
          element.props.alt === 'Attachment sent with the message'
      )
    ).toHaveLength(0);
  });
});
